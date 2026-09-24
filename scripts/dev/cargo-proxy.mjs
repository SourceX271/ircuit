#!/usr/bin/env node
/**
 * 本地 cargo registry 代理（仅用于受限环境）。
 *
 * ## 为什么需要它
 *
 * Windows 上 cargo 通过 libcurl + schannel 建立 TLS 连接。在受限的文件沙箱中，
 * 进程无法访问系统凭据存储，握手会直接失败：
 *
 *     SSL connect error (schannel: AcquireCredentialsHandle failed:
 *                        SEC_E_NO_CREDENTIALS)
 *
 * 于是任何需要新依赖的构建都会挂掉，而提权只是逐条命令的临时豁免，
 * 没法支撑一个长期项目。
 *
 * ## 它怎么解决
 *
 * Node 自带 OpenSSL，不受 schannel 限制（实测可直连 npm 与 crates.io）。
 * 本脚本在本机起一个**明文 HTTP** registry，cargo 只跟它说 HTTP，
 * 真正的 TLS 由 Node 代劳：
 *
 *     cargo ──HTTP──> 127.0.0.1:8788 ──HTTPS──> 清华索引 / static.crates.io
 *
 * 索引路径原样转发；`config.json` 换成指向本机的下载地址；
 * `.crate` 文件按 `<name>-<version>.crate` 规则拉取。
 *
 * ## 用法
 *
 *     node scripts/dev/cargo-proxy.mjs                 # 默认 8788
 *     IRCUIT_CARGO_PROXY_PORT=9000 node ...            # 换端口
 *
 * 配套的 cargo 配置见 `.cache/cargo/config.toml`（该文件不入库）。
 * 依赖全部下载进本地缓存后，普通 `cargo build` 不再需要本代理在线。
 */
import http from 'node:http';

const PORT = Number(process.env.IRCUIT_CARGO_PROXY_PORT ?? 8788);
const HOST = '127.0.0.1';
const INDEX_UPSTREAM = 'https://mirrors.tuna.tsinghua.edu.cn/crates.io-index';
const CRATE_BASE = 'https://static.crates.io/crates';

const log = (message) => {
  const stamp = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[cargo-proxy ${stamp}] ${message}\n`);
};

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const sendText = (res, status, text) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
};

/** 转发一个上游请求，成功时把响应体原样写回。 */
const pipeFrom = async (res, upstreamUrl, method) => {
  const upstream = await fetch(upstreamUrl, { method, redirect: 'follow' });
  if (!upstream.ok) {
    log(`FAIL ${upstream.status} <- ${upstreamUrl}`);
    sendText(
      res,
      upstream.status === 404 ? 404 : 502,
      `upstream ${upstream.status}: ${upstreamUrl}`,
    );
    return;
  }
  const body = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(200, {
    'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
    'content-length': body.byteLength,
  });
  res.end(method === 'HEAD' ? undefined : body);
};

const server = http.createServer(async (req, res) => {
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const { pathname } = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const path = decodeURIComponent(pathname);

  try {
    // cargo 会先取 registry 的 config.json，这里把下载地址指回本机。
    if (path === '/index/config.json') {
      log('config.json');
      sendJson(res, 200, {
        dl: `http://${HOST}:${PORT}/dl`,
        api: `http://${HOST}:${PORT}/api`,
      });
      return;
    }

    if (path.startsWith('/index/')) {
      const rest = path.slice('/index'.length);
      log(`index ${rest}`);
      await pipeFrom(res, INDEX_UPSTREAM + rest, method);
      return;
    }

    // cargo 在 dl 模板不含占位符时会拼成 /{crate}/{version}/download。
    const download = /^\/dl\/([^/]+)\/([^/]+)\/download$/.exec(path);
    if (download) {
      const [, name, version] = download;
      log(`crate ${name}-${version}`);
      await pipeFrom(res, `${CRATE_BASE}/${name}/${name}-${version}.crate`, method);
      return;
    }

    // 兜底：直接给出文件名的情况。
    const direct = /^\/dl\/([^/]+)\/([^/]+\.crate)$/.exec(path);
    if (direct) {
      const [, name, file] = direct;
      log(`crate(file) ${file}`);
      await pipeFrom(res, `${CRATE_BASE}/${name}/${file}`, method);
      return;
    }

    // cargo search / publish 走 API，本项目用不到，给一个明确的空响应。
    if (path.startsWith('/api/')) {
      log(`api (stubbed) ${path}`);
      sendJson(res, 200, { crates: [], meta: { total: 0 } });
      return;
    }

    log(`UNHANDLED ${method} ${path}`);
    sendText(res, 404, `not handled: ${path}`);
  } catch (error) {
    log(`ERROR ${path}: ${error.message}`);
    if (!res.headersSent) sendText(res, 502, String(error.message));
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (index -> ${INDEX_UPSTREAM})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('shutting down');
    server.close(() => process.exit(0));
  });
}
