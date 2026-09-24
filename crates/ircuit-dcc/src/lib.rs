//! DCC (Direct Client-to-Client) chat and file transfer.
//!
//! DCC bypasses the IRC server: peers exchange an address and port over IRC and
//! then talk directly. That makes it fast and private, and also means it fails
//! behind NAT and firewalls — which is why the client pairs it with an HTTP
//! upload fallback rather than presenting DCC as universally reliable.
//!
//! Planned support: `DCC CHAT`, `DCC SEND` with `RESUME`, `ACCEPT` and passive
//! (`DCC SEND` reverse) negotiation.
//!
//! **M0 scope**: crate skeleton only. Implementation lands in M5.
