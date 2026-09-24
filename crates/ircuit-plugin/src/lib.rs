//! Sandboxed plugin host.
//!
//! Plugins are JavaScript running on QuickJS, not Node: they start with no
//! filesystem and no network access, must declare the permissions they want,
//! and run under execution-time and memory limits. Capability level agreed for
//! v1 is *medium* — event hooks, custom commands, a sidebar panel, settings-page
//! extensions and whitelisted network requests.
//!
//! **M0 scope**: crate skeleton only. The `rquickjs` dependency is introduced in
//! M6 together with the host, so M0 does not pay the cost of compiling bundled
//! QuickJS.
