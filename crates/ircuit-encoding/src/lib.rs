//! Text encoding detection and conversion for IRC traffic.
//!
//! IRC carries raw bytes, and older networks — notably some Chinese IRC
//! servers — still speak GBK/GB18030 rather than UTF-8. This crate isolates
//! that concern so the rest of the client can work in `String` without
//! worrying about mojibake.
//!
//! Planned behaviour, decided in the requirements phase:
//!
//! - UTF-8 is the default.
//! - Automatic detection is a *fallback*, never an override: an explicit
//!   per-network or per-channel setting always wins, and a detected result can
//!   be corrected from the UI.
//! - Any encoding supported by `encoding_rs` is selectable.
//!
//! **M0 scope**: crate skeleton only. Implementation lands in M4, where the
//! `encoding_rs` and `chardetng` dependencies are introduced together with the
//! settings UI that drives them.
