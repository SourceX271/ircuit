//! Channel and membership state.
//!
//! This is where the client decides who is in a channel, what their prefixes are,
//! and what the channel's modes and topic say. Everything is derived from
//! protocol messages, and the whole model is pure — [`NetworkState::apply`] takes
//! a message and reports what changed — so it can be driven through every
//! awkward sequence in tests without a socket.
//!
//! # Case mapping
//!
//! IRC compares nicknames and channel names case-insensitively, but *which*
//! characters are equivalent depends on the server's `CASEMAPPING`. Getting this
//! wrong means `@Alice` and `alice` become two members, so the mapping is
//! modelled explicitly rather than approximated with `to_lowercase`.

use std::collections::BTreeMap;

use ircuit_proto::{Command, Message};

/// How the server folds case when comparing nicknames and channel names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CaseMapping {
    /// `A-Z` only.
    Ascii,
    /// `A-Z` plus `[]\~` folding to `{|}^`. The historical default.
    #[default]
    Rfc1459,
    /// Like [`Self::Rfc1459`] but without the `~`/`^` pair.
    Rfc1459Strict,
}

impl CaseMapping {
    /// Parse the value of the `CASEMAPPING` token.
    #[must_use]
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.to_ascii_lowercase().as_str() {
            "ascii" => Some(Self::Ascii),
            "rfc1459" => Some(Self::Rfc1459),
            "rfc1459-strict" => Some(Self::Rfc1459Strict),
            _ => None,
        }
    }

    /// Fold a nickname or channel name for comparison and map keys.
    #[must_use]
    pub fn fold(self, value: &str) -> String {
        value
            .chars()
            .map(|ch| match ch {
                'A'..='Z' => ch.to_ascii_lowercase(),
                '[' if self != Self::Ascii => '{',
                ']' if self != Self::Ascii => '}',
                '\\' if self != Self::Ascii => '|',
                '~' if self == Self::Rfc1459 => '^',
                other => other,
            })
            .collect()
    }
}

/// The subset of `ISUPPORT` (numeric 005) this model acts on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Isupport {
    pub case_mapping: CaseMapping,
    /// Channel prefixes, e.g. `#&`.
    pub channel_types: String,
    /// `(mode, prefix)` pairs, highest rank first.
    pub prefix_modes: Vec<(char, char)>,
    /// `CHANMODES=A,B,C,D`, the four argument-taking groups.
    pub chan_modes: [String; 4],
    pub nick_length: usize,
    pub topic_length: usize,
}

impl Default for Isupport {
    fn default() -> Self {
        Self {
            case_mapping: CaseMapping::default(),
            channel_types: "#&".to_owned(),
            // The near-universal default: owner, admin, op, halfop, voice.
            prefix_modes: vec![('q', '~'), ('a', '&'), ('o', '@'), ('h', '%'), ('v', '+')],
            // A: always takes a parameter, listed; B: always takes one;
            // C: takes one only when set; D: never takes one.
            chan_modes: [
                "beI".to_owned(),
                "k".to_owned(),
                "l".to_owned(),
                "imnpst".to_owned(),
            ],
            nick_length: 30,
            topic_length: 390,
        }
    }
}

impl Isupport {
    /// The prefix character for a mode letter, if the server uses one.
    #[must_use]
    pub fn prefix_for_mode(&self, mode: char) -> Option<char> {
        self.prefix_modes
            .iter()
            .find(|(candidate, _)| *candidate == mode)
            .map(|(_, prefix)| *prefix)
    }

    /// The mode letter for a prefix character.
    #[must_use]
    pub fn mode_for_prefix(&self, prefix: char) -> Option<char> {
        self.prefix_modes
            .iter()
            .find(|(_, candidate)| *candidate == prefix)
            .map(|(mode, _)| *mode)
    }

    /// Whether a mode letter carries a parameter.
    ///
    /// The `adding` flag matters for group C — `+l 50` has an argument, `-l`
    /// does not — and getting it wrong shifts every later parameter by one.
    #[must_use]
    pub fn takes_argument(&self, mode: char, adding: bool) -> bool {
        if self
            .prefix_modes
            .iter()
            .any(|(candidate, _)| *candidate == mode)
        {
            return true;
        }

        if self.chan_modes[0].contains(mode) || self.chan_modes[1].contains(mode) {
            return true;
        }

        if self.chan_modes[2].contains(mode) {
            return adding;
        }

        false
    }

    /// Whether `name` looks like a channel on this server.
    #[must_use]
    pub fn is_channel(&self, name: &str) -> bool {
        name.chars()
            .next()
            .is_some_and(|first| self.channel_types.contains(first))
    }

    /// Apply one `ISUPPORT` token such as `PREFIX=(ov)@+`.
    fn apply_token(&mut self, token: &str) {
        let (key, value) = match token.split_once('=') {
            Some((key, value)) => (key, value),
            None => (token, ""),
        };

        match key.to_ascii_uppercase().as_str() {
            "CASEMAPPING" => {
                if let Some(mapping) = CaseMapping::parse(value) {
                    self.case_mapping = mapping;
                }
            }
            "CHANTYPES" => {
                if !value.is_empty() {
                    self.channel_types = value.to_owned();
                }
            }
            "PREFIX" => {
                // (modes)prefixes — e.g. (ov)@+
                let Some(rest) = value.strip_prefix('(') else {
                    return;
                };
                let Some((modes, prefixes)) = rest.split_once(')') else {
                    return;
                };

                let parsed: Vec<(char, char)> = modes.chars().zip(prefixes.chars()).collect();

                if !parsed.is_empty() {
                    self.prefix_modes = parsed;
                }
            }
            "CHANMODES" => {
                let groups: Vec<&str> = value.split(',').collect();
                if groups.len() == 4 {
                    for (slot, group) in self.chan_modes.iter_mut().zip(groups) {
                        group.clone_into(slot);
                    }
                }
            }
            "NICKLEN" => {
                if let Ok(length) = value.parse() {
                    self.nick_length = length;
                }
            }
            "TOPICLEN" => {
                if let Ok(length) = value.parse() {
                    self.topic_length = length;
                }
            }
            _ => {}
        }
    }
}

/// Someone in a channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
    /// The nickname as the server spells it.
    pub nick: String,
    /// Mode letters the member holds, e.g. `['o', 'v']`.
    pub modes: Vec<char>,
    /// Whether the server has told us they are away.
    pub away: bool,
    /// Services account, when the server provides one.
    pub account: Option<String>,
}

impl Member {
    #[must_use]
    pub fn new(nick: impl Into<String>) -> Self {
        Self {
            nick: nick.into(),
            modes: Vec::new(),
            away: false,
            account: None,
        }
    }

    /// The highest-ranked prefix character this member holds.
    #[must_use]
    pub fn highest_prefix(&self, isupport: &Isupport) -> Option<char> {
        isupport
            .prefix_modes
            .iter()
            .find(|(mode, _)| self.modes.contains(mode))
            .map(|(_, prefix)| *prefix)
    }

    /// Rank for sorting: lower is more privileged, plain members come last.
    #[must_use]
    pub fn rank(&self, isupport: &Isupport) -> usize {
        isupport
            .prefix_modes
            .iter()
            .position(|(mode, _)| self.modes.contains(mode))
            .unwrap_or(isupport.prefix_modes.len())
    }
}

/// One channel the client is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Channel {
    /// The name as the server spells it.
    pub name: String,
    pub topic: Option<String>,
    /// Members keyed by folded nickname.
    pub members: BTreeMap<String, Member>,
    /// Modes and their arguments. A mode with no argument maps to `None`.
    pub modes: BTreeMap<char, Option<String>>,
    /// Whether the initial `NAMES` burst has finished.
    ///
    /// Until it has, an empty member list means "not asked yet", not "empty
    /// channel", and the UI has to tell those apart.
    pub names_received: bool,
}

impl Channel {
    #[must_use]
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            topic: None,
            members: BTreeMap::new(),
            modes: BTreeMap::new(),
            names_received: false,
        }
    }

    /// Members sorted by privilege, then by nickname.
    #[must_use]
    pub fn sorted_members(&self, isupport: &Isupport) -> Vec<&Member> {
        let mut members: Vec<&Member> = self.members.values().collect();
        members.sort_by(|left, right| {
            let by_rank = left.rank(isupport).cmp(&right.rank(isupport));
            if by_rank != std::cmp::Ordering::Equal {
                return by_rank;
            }
            isupport
                .case_mapping
                .fold(&left.nick)
                .cmp(&isupport.case_mapping.fold(&right.nick))
        });
        members
    }

    /// The mode string as users would type it, e.g. `+nt`.
    #[must_use]
    pub fn mode_string(&self) -> String {
        if self.modes.is_empty() {
            return String::new();
        }

        let mut out = String::from("+");
        out.extend(self.modes.keys());
        out
    }
}

/// What applying a message changed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateChange {
    /// This channel's state changed.
    Channel(String),
    /// This channel is gone.
    ChannelRemoved(String),
    /// The user's own nickname changed.
    Nick(String),
    /// Membership may have changed in every channel, e.g. after a `QUIT`.
    AllChannels,
    /// `ISUPPORT` changed, which can affect how every name is compared.
    Isupport,
}

/// Everything the client knows about one network's channels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkState {
    /// The nickname the server currently knows us by.
    pub nick: String,
    /// Channels keyed by folded name.
    pub channels: BTreeMap<String, Channel>,
    pub isupport: Isupport,
}

impl NetworkState {
    #[must_use]
    pub fn new(nick: impl Into<String>) -> Self {
        Self {
            nick: nick.into(),
            channels: BTreeMap::new(),
            isupport: Isupport::default(),
        }
    }

    #[must_use]
    pub fn channel(&self, name: &str) -> Option<&Channel> {
        self.channels.get(&self.isupport.case_mapping.fold(name))
    }

    fn fold(&self, value: &str) -> String {
        self.isupport.case_mapping.fold(value)
    }

    fn self_folded(&self) -> String {
        self.isupport.case_mapping.fold(&self.nick)
    }

    /// Rename the client's own nickname.
    pub fn set_nick(&mut self, nick: impl Into<String>) {
        self.nick = nick.into();
    }

    /// Apply one message and report what changed.
    ///
    /// Unknown or unmodelled messages return an empty list rather than an error:
    /// a client that trips over a command it does not recognise is unusable.
    pub fn apply(&mut self, message: &Message) -> Vec<StateChange> {
        match &message.command {
            Command::Numeric(5) => self.on_isupport(message),
            Command::Numeric(332) => self.on_topic_reply(message),
            Command::Numeric(353) => self.on_names_reply(message),
            Command::Numeric(366) => self.on_end_of_names(message),
            Command::Join => self.on_join(message),
            Command::Part => self.on_part(message),
            Command::Quit => self.on_quit(message),
            Command::Kick => self.on_kick(message),
            Command::Nick => self.on_nick(message),
            Command::Mode => self.on_mode(message),
            Command::Topic => self.on_topic(message),
            Command::Away => self.on_away(message),
            Command::Account => self.on_account(message),
            _ => Vec::new(),
        }
    }

    fn on_isupport(&mut self, message: &Message) -> Vec<StateChange> {
        // `:server 005 nick TOKEN TOKEN ... :are supported by this server`
        for token in message.params.iter().skip(1) {
            // The trailing human-readable text is not a token.
            if token.contains(' ') {
                break;
            }
            self.isupport.apply_token(token);
        }

        vec![StateChange::Isupport]
    }

    fn on_names_reply(&mut self, message: &Message) -> Vec<StateChange> {
        // `:server 353 me = #chan :@alice +bob carol`
        let Some(channel_name) = message.param(2) else {
            return Vec::new();
        };
        let names = message.param(3).unwrap_or_default();

        // Copy out what the loop needs: `self.fold` borrows all of `self`, which
        // cannot coexist with the mutable borrow of `self.channels` below.
        let case_mapping = self.isupport.case_mapping;
        let prefix_modes = self.isupport.prefix_modes.clone();
        let key = case_mapping.fold(channel_name);

        let channel = self
            .channels
            .entry(key.clone())
            .or_insert_with(|| Channel::new(channel_name));

        for entry in names.split_whitespace() {
            let (modes, nick) = split_prefixes(entry, &prefix_modes);
            if nick.is_empty() {
                continue;
            }

            let member = channel
                .members
                .entry(case_mapping.fold(nick))
                .or_insert_with(|| Member::new(nick));

            // A NAMES burst is authoritative for prefixes, so replace rather than
            // merge; a stale `+` from an earlier MODE would otherwise stick.
            member.modes = modes;
        }

        vec![StateChange::Channel(self.channels[&key].name.clone())]
    }

    fn on_end_of_names(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(channel_name) = message.param(1) else {
            return Vec::new();
        };

        let key = self.fold(channel_name);

        // The channel may not exist yet if the server sent 366 without a 353.
        let channel = self
            .channels
            .entry(key.clone())
            .or_insert_with(|| Channel::new(channel_name));

        channel.names_received = true;

        vec![StateChange::Channel(self.channels[&key].name.clone())]
    }

    fn on_join(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(channel_name) = message.param(0) else {
            return Vec::new();
        };
        let Some(nick) = message.nick() else {
            return Vec::new();
        };

        let case_mapping = self.isupport.case_mapping;
        let key = case_mapping.fold(channel_name);
        let nick_key = case_mapping.fold(nick);
        let is_self = nick_key == self.self_folded();

        let channel = self
            .channels
            .entry(key.clone())
            .or_insert_with(|| Channel::new(channel_name));

        if is_self {
            // We just joined, so we know nobody; the NAMES burst that follows is
            // the authoritative list. Clearing here also drops members left over
            // from a previous session in the same channel.
            channel.members.clear();
            channel.names_received = false;
        }

        channel
            .members
            .entry(nick_key)
            .or_insert_with(|| Member::new(nick));

        vec![StateChange::Channel(self.channels[&key].name.clone())]
    }

    fn on_part(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(channel_name) = message.param(0) else {
            return Vec::new();
        };
        let Some(nick) = message.nick() else {
            return Vec::new();
        };

        let key = self.fold(channel_name);
        let is_self = self.fold(nick) == self.fold(&self.nick.clone());

        if is_self {
            return match self.channels.remove(&key) {
                Some(channel) => vec![StateChange::ChannelRemoved(channel.name)],
                None => Vec::new(),
            };
        }

        let folded_nick = self.fold(nick);
        match self.channels.get_mut(&key) {
            Some(channel) => {
                channel.members.remove(&folded_nick);
                vec![StateChange::Channel(channel.name.clone())]
            }
            None => Vec::new(),
        }
    }

    fn on_quit(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(nick) = message.nick() else {
            return Vec::new();
        };

        let folded = self.fold(nick);
        let mut changed = false;

        for channel in self.channels.values_mut() {
            if channel.members.remove(&folded).is_some() {
                changed = true;
            }
        }

        // A quit affects an unknown set of channels, so let the caller decide
        // which snapshots to refresh.
        if changed {
            vec![StateChange::AllChannels]
        } else {
            Vec::new()
        }
    }

    fn on_kick(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(channel_name) = message.param(0) else {
            return Vec::new();
        };
        let Some(victim) = message.param(1) else {
            return Vec::new();
        };

        let key = self.fold(channel_name);
        let is_self = self.fold(victim) == self.self_folded();
        let folded_victim = self.fold(victim);

        if is_self {
            return match self.channels.remove(&key) {
                Some(channel) => vec![StateChange::ChannelRemoved(channel.name)],
                None => Vec::new(),
            };
        }

        match self.channels.get_mut(&key) {
            Some(channel) => {
                channel.members.remove(&folded_victim);
                vec![StateChange::Channel(channel.name.clone())]
            }
            None => Vec::new(),
        }
    }

    fn on_nick(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(new_nick) = message.param(0) else {
            return Vec::new();
        };
        let Some(old_nick) = message.nick() else {
            return Vec::new();
        };

        let case_mapping = self.isupport.case_mapping;
        let old_key = case_mapping.fold(old_nick);
        let new_key = case_mapping.fold(new_nick);
        let is_self = old_key == self.self_folded();

        for channel in self.channels.values_mut() {
            if let Some(mut member) = channel.members.remove(&old_key) {
                member.nick = new_nick.to_owned();
                channel.members.insert(new_key.clone(), member);
            }
        }

        if is_self {
            self.nick = new_nick.to_owned();
            return vec![StateChange::Nick(new_nick.to_owned())];
        }

        Vec::new()
    }

    fn on_mode(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(target) = message.param(0) else {
            return Vec::new();
        };

        // A user mode (`MODE nick +i`) is not channel state.
        if !self.isupport.is_channel(target) {
            return Vec::new();
        }

        let Some(modes) = message.param(1) else {
            return Vec::new();
        };

        let key = self.fold(target);
        let case_mapping = self.isupport.case_mapping;
        let prefix_modes = self.isupport.prefix_modes.clone();
        let arguments: Vec<String> = message.params.iter().skip(2).cloned().collect();
        let mut argument_index = 0usize;

        // Collect the mutations first so the borrow of `self.channels` stays short.
        let mut mode_changes: Vec<(bool, char, Option<String>)> = Vec::new();
        let mut adding = true;

        for mode in modes.chars() {
            match mode {
                '+' => adding = true,
                '-' => adding = false,
                _ => {
                    let argument = if self.isupport.takes_argument(mode, adding) {
                        let value = arguments.get(argument_index).cloned();
                        argument_index += 1;
                        value
                    } else {
                        None
                    };

                    mode_changes.push((adding, mode, argument));
                }
            }
        }

        let Some(channel) = self.channels.get_mut(&key) else {
            return Vec::new();
        };

        for (adding, mode, argument) in mode_changes {
            if prefix_modes.iter().any(|(candidate, _)| *candidate == mode) {
                let Some(nick) = argument else { continue };
                let folded = case_mapping.fold(&nick);

                if let Some(member) = channel.members.get_mut(&folded) {
                    if adding {
                        if !member.modes.contains(&mode) {
                            member.modes.push(mode);
                        }
                    } else {
                        member.modes.retain(|candidate| *candidate != mode);
                    }
                }
                continue;
            }

            if adding {
                channel.modes.insert(mode, argument);
            } else {
                channel.modes.remove(&mode);
            }
        }

        vec![StateChange::Channel(self.channels[&key].name.clone())]
    }

    fn on_topic(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(channel_name) = message.param(0) else {
            return Vec::new();
        };
        let topic = message.param(1).unwrap_or_default().to_owned();

        let key = self.fold(channel_name);
        match self.channels.get_mut(&key) {
            Some(channel) => {
                channel.topic = if topic.is_empty() { None } else { Some(topic) };
                vec![StateChange::Channel(channel.name.clone())]
            }
            None => Vec::new(),
        }
    }

    fn on_topic_reply(&mut self, message: &Message) -> Vec<StateChange> {
        // `:server 332 nick #chan :the topic`
        let Some(channel_name) = message.param(1) else {
            return Vec::new();
        };
        let topic = message.param(2).unwrap_or_default().to_owned();

        let key = self.fold(channel_name);
        match self.channels.get_mut(&key) {
            Some(channel) => {
                channel.topic = if topic.is_empty() { None } else { Some(topic) };
                vec![StateChange::Channel(channel.name.clone())]
            }
            None => Vec::new(),
        }
    }

    fn on_away(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(nick) = message.nick() else {
            return Vec::new();
        };

        // An AWAY with no parameter means "back".
        let away = message.param(0).is_some();
        let folded = self.fold(nick);
        let mut changed = false;

        for channel in self.channels.values_mut() {
            if let Some(member) = channel.members.get_mut(&folded) {
                member.away = away;
                changed = true;
            }
        }

        if changed {
            vec![StateChange::AllChannels]
        } else {
            Vec::new()
        }
    }

    fn on_account(&mut self, message: &Message) -> Vec<StateChange> {
        let Some(nick) = message.nick() else {
            return Vec::new();
        };

        // `ACCOUNT *` means logged out.
        let account = message
            .param(0)
            .filter(|value| *value != "*")
            .map(str::to_owned);

        let folded = self.fold(nick);
        let mut changed = false;

        for channel in self.channels.values_mut() {
            if let Some(member) = channel.members.get_mut(&folded) {
                member.account = account.clone();
                changed = true;
            }
        }

        if changed {
            vec![StateChange::AllChannels]
        } else {
            Vec::new()
        }
    }
}

/// Split `@+nick` into its mode letters and the nickname.
///
/// Servers may stack prefixes, and which characters count as prefixes depends on
/// `PREFIX`, so this cannot be a fixed set.
fn split_prefixes<'a>(entry: &'a str, prefix_modes: &[(char, char)]) -> (Vec<char>, &'a str) {
    let mut modes = Vec::new();
    let mut rest = entry;

    while let Some(first) = rest.chars().next() {
        match prefix_modes
            .iter()
            .find(|(_, prefix)| *prefix == first)
            .map(|(mode, _)| *mode)
        {
            Some(mode) => {
                modes.push(mode);
                rest = &rest[first.len_utf8()..];
            }
            None => break,
        }
    }

    (modes, rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(line: &str) -> Message {
        Message::parse(line).expect("test line should parse")
    }

    fn state_with(nick: &str, lines: &[&str]) -> NetworkState {
        let mut state = NetworkState::new(nick);
        for line in lines {
            state.apply(&message(line));
        }
        state
    }

    #[test]
    fn case_mapping_folds_the_right_characters() {
        assert_eq!(CaseMapping::Rfc1459.fold("Alice"), "alice");
        assert_eq!(CaseMapping::Rfc1459.fold("[Foo]"), "{foo}");
        assert_eq!(CaseMapping::Rfc1459.fold("a~b"), "a^b");

        // Strict leaves the tilde alone.
        assert_eq!(CaseMapping::Rfc1459Strict.fold("a~b"), "a~b");
        // Ascii folds letters only.
        assert_eq!(CaseMapping::Ascii.fold("[Foo]~"), "[foo]~");
    }

    #[test]
    fn isupport_defaults_are_the_common_case() {
        let isupport = Isupport::default();
        assert!(isupport.is_channel("#rust"));
        assert!(isupport.is_channel("&local"));
        assert!(!isupport.is_channel("alice"));
        assert_eq!(isupport.prefix_for_mode('o'), Some('@'));
        assert_eq!(isupport.mode_for_prefix('+'), Some('v'));
    }

    #[test]
    fn isupport_tokens_override_the_defaults() {
        let state = state_with(
            "me",
            &[":s 005 me PREFIX=(ov)@+ CHANTYPES=# CASEMAPPING=ascii :are supported"],
        );

        assert_eq!(state.isupport.case_mapping, CaseMapping::Ascii);
        assert_eq!(state.isupport.channel_types, "#");
        assert_eq!(state.isupport.prefix_modes, vec![('o', '@'), ('v', '+')]);
        assert!(!state.isupport.is_channel("&local"));
    }

    #[test]
    fn names_burst_creates_members_with_prefixes() {
        let state = state_with(
            "me",
            &[
                ":s 353 me = #rust :@alice +bob carol",
                ":s 366 me #rust :End of /NAMES list.",
            ],
        );

        let channel = state.channel("#rust").expect("channel should exist");
        assert!(channel.names_received);
        assert_eq!(channel.members.len(), 3);

        let folded = state.isupport.case_mapping.fold("alice");
        assert_eq!(channel.members[&folded].modes, vec!['o']);
        assert_eq!(
            channel.members[&folded].highest_prefix(&state.isupport),
            Some('@')
        );
    }

    #[test]
    fn stacked_prefixes_are_all_recorded() {
        let state = state_with("me", &[":s 353 me = #c :@+alice bob"]);

        let folded = state.isupport.case_mapping.fold("alice");
        let member = &state.channel("#c").unwrap().members[&folded];

        assert_eq!(member.modes, vec!['o', 'v']);
        // The highest-ranked prefix wins for display.
        assert_eq!(member.highest_prefix(&state.isupport), Some('@'));
    }

    #[test]
    fn members_are_sorted_by_privilege_then_name() {
        let state = state_with("me", &[":s 353 me = #c :carol @bob +alice dave"]);

        let names: Vec<&str> = state
            .channel("#c")
            .unwrap()
            .sorted_members(&state.isupport)
            .iter()
            .map(|member| member.nick.as_str())
            .collect();

        assert_eq!(names, vec!["bob", "alice", "carol", "dave"]);
    }

    #[test]
    fn a_names_burst_is_authoritative_for_prefixes() {
        // A `+` applied earlier must not survive a later NAMES that omits it.
        let state = state_with(
            "me",
            &[
                ":s 353 me = #c :alice",
                ":s MODE #c +v alice",
                ":s 353 me = #c :alice",
            ],
        );

        let folded = state.isupport.case_mapping.fold("alice");
        assert!(state.channel("#c").unwrap().members[&folded]
            .modes
            .is_empty());
    }

    #[test]
    fn mode_changes_update_member_prefixes() {
        let state = state_with(
            "me",
            &[
                ":s 353 me = #c :alice bob",
                ":s MODE #c +o alice",
                ":s MODE #c +v bob",
            ],
        );

        let channel = state.channel("#c").unwrap();
        let alice = &channel.members[&state.isupport.case_mapping.fold("alice")];
        let bob = &channel.members[&state.isupport.case_mapping.fold("bob")];

        assert_eq!(alice.modes, vec!['o']);
        assert_eq!(bob.modes, vec!['v']);
    }

    #[test]
    fn removing_a_prefix_works() {
        let state = state_with("me", &[":s 353 me = #c :@alice", ":s MODE #c -o alice"]);

        let folded = state.isupport.case_mapping.fold("alice");
        assert!(state.channel("#c").unwrap().members[&folded]
            .modes
            .is_empty());
    }

    #[test]
    fn multiple_mode_changes_consume_arguments_in_order() {
        let state = state_with(
            "me",
            &[":s 353 me = #c :alice bob", ":s MODE #c +ov alice bob"],
        );

        let channel = state.channel("#c").unwrap();
        assert_eq!(
            channel.members[&state.isupport.case_mapping.fold("alice")].modes,
            vec!['o']
        );
        assert_eq!(
            channel.members[&state.isupport.case_mapping.fold("bob")].modes,
            vec!['v']
        );
    }

    #[test]
    fn channel_modes_with_and_without_arguments_are_tracked() {
        let state = state_with(
            "me",
            &[
                ":me!m@h JOIN #c",
                ":s 353 me = #c :me",
                ":s MODE #c +nt",
                ":s MODE #c +k secret",
            ],
        );

        let channel = state.channel("#c").unwrap();
        assert_eq!(channel.modes.get(&'n'), Some(&None));
        assert_eq!(channel.modes.get(&'t'), Some(&None));
        assert_eq!(channel.modes.get(&'k'), Some(&Some("secret".to_owned())));
        assert_eq!(channel.mode_string(), "+knt");
    }

    #[test]
    fn user_modes_are_not_channel_state() {
        let state = state_with("me", &[":s 005 me CHANTYPES=#", ":s MODE me +i"]);
        assert!(state.channels.is_empty());
    }

    #[test]
    fn parting_removes_a_member_but_keeps_the_channel() {
        let state = state_with(
            "me",
            &[":s 353 me = #c :me alice", ":alice!a@h PART #c :bye"],
        );

        let channel = state.channel("#c").unwrap();
        assert_eq!(channel.members.len(), 1);
    }

    #[test]
    fn parting_ourselves_removes_the_channel() {
        let mut state = state_with("me", &[":s 353 me = #c :me alice"]);
        let changes = state.apply(&message(":me!m@h PART #c :bye"));

        assert!(state.channel("#c").is_none());
        assert_eq!(changes, vec![StateChange::ChannelRemoved("#c".to_owned())]);
    }

    #[test]
    fn being_kicked_removes_the_channel() {
        let mut state = state_with("me", &[":s 353 me = #c :me alice"]);
        let changes = state.apply(&message(":op!o@h KICK #c me :go away"));

        assert!(state.channel("#c").is_none());
        assert_eq!(changes, vec![StateChange::ChannelRemoved("#c".to_owned())]);
    }

    #[test]
    fn kicking_someone_else_keeps_the_channel() {
        let state = state_with(
            "me",
            &[":s 353 me = #c :me alice", ":op!o@h KICK #c alice :bye"],
        );

        assert_eq!(state.channel("#c").unwrap().members.len(), 1);
    }

    #[test]
    fn quitting_affects_every_channel() {
        let mut state = state_with(
            "me",
            &[":s 353 me = #a :me alice", ":s 353 me = #b :me alice"],
        );

        let changes = state.apply(&message(":alice!a@h QUIT :gone"));

        assert_eq!(changes, vec![StateChange::AllChannels]);
        assert!(state.channel("#a").unwrap().members.len() == 1);
        assert!(state.channel("#b").unwrap().members.len() == 1);
    }

    #[test]
    fn a_nick_change_renames_the_member_everywhere() {
        let state = state_with(
            "me",
            &[
                ":s 353 me = #a :me alice",
                ":s 353 me = #b :me alice",
                ":alice!a@h NICK alice_",
            ],
        );

        let folded = state.isupport.case_mapping.fold("alice_");
        assert!(state.channel("#a").unwrap().members.contains_key(&folded));
        assert!(state.channel("#b").unwrap().members.contains_key(&folded));
    }

    #[test]
    fn our_own_nick_change_updates_the_state() {
        let mut state = state_with("me", &[":s 353 me = #c :me"]);
        let changes = state.apply(&message(":me!m@h NICK alice"));

        assert_eq!(state.nick, "alice");
        assert_eq!(changes, vec![StateChange::Nick("alice".to_owned())]);
    }

    #[test]
    fn nick_comparison_uses_the_server_case_mapping() {
        // Under rfc1459, `[Foo]` and `{foo}` are the same nick.
        let state = state_with("me", &[":s 353 me = #c :[Foo]", ":s MODE #c +o {foo}"]);

        let folded = state.isupport.case_mapping.fold("[Foo]");
        assert_eq!(
            state.channel("#c").unwrap().members[&folded].modes,
            vec!['o']
        );
    }

    #[test]
    fn topic_is_set_from_both_the_command_and_the_reply() {
        let state = state_with("me", &[":s 353 me = #c :me", ":s 332 me #c :the topic"]);
        assert_eq!(
            state.channel("#c").unwrap().topic.as_deref(),
            Some("the topic")
        );

        let state = state_with(
            "me",
            &[
                ":s 353 me = #c :me",
                ":s 332 me #c :old",
                ":op!o@h TOPIC #c :new topic",
            ],
        );
        assert_eq!(
            state.channel("#c").unwrap().topic.as_deref(),
            Some("new topic")
        );
    }

    #[test]
    fn an_empty_topic_clears_it() {
        let state = state_with("me", &[":s 353 me = #c :me", ":op!o@h TOPIC #c :"]);
        assert!(state.channel("#c").unwrap().topic.is_none());
    }

    #[test]
    fn away_notify_marks_members() {
        let state = state_with(
            "me",
            &[":s 353 me = #c :me alice", ":alice!a@h AWAY :at lunch"],
        );

        let folded = state.isupport.case_mapping.fold("alice");
        assert!(state.channel("#c").unwrap().members[&folded].away);

        let state = state_with(
            "me",
            &[
                ":s 353 me = #c :me alice",
                ":alice!a@h AWAY :at lunch",
                ":alice!a@h AWAY",
            ],
        );
        assert!(!state.channel("#c").unwrap().members[&folded].away);
    }

    #[test]
    fn account_notify_tracks_services_logins() {
        let state = state_with(
            "me",
            &[":s 353 me = #c :me alice", ":alice!a@h ACCOUNT aliceacct"],
        );

        let folded = state.isupport.case_mapping.fold("alice");
        assert_eq!(
            state.channel("#c").unwrap().members[&folded]
                .account
                .as_deref(),
            Some("aliceacct")
        );

        // `*` means logged out.
        let state = state_with(
            "me",
            &[
                ":s 353 me = #c :me alice",
                ":alice!a@h ACCOUNT aliceacct",
                ":alice!a@h ACCOUNT *",
            ],
        );
        assert!(state.channel("#c").unwrap().members[&folded]
            .account
            .is_none());
    }

    #[test]
    fn unmodelled_messages_change_nothing() {
        let mut state = state_with("me", &[":s 353 me = #c :me"]);
        assert!(state.apply(&message(":s 001 me :Welcome")).is_empty());
        assert!(state.apply(&message("PING :1")).is_empty());
        assert!(state.apply(&message(":s NOTICE me :hi")).is_empty());
    }

    #[test]
    fn our_own_join_clears_the_member_list_until_names_arrives() {
        let mut state = state_with(
            "me",
            &[
                ":s 353 me = #c :me alice bob",
                ":s 366 me #c :End of /NAMES list.",
            ],
        );
        assert!(state.channel("#c").unwrap().names_received);
        assert_eq!(state.channel("#c").unwrap().members.len(), 3);

        // Rejoining must not leave the previous member list on screen.
        state.apply(&message(":me!m@h JOIN #c"));

        let channel = state.channel("#c").unwrap();
        assert!(!channel.names_received);
        assert_eq!(channel.members.len(), 1, "only we are known after a rejoin");
    }

    #[test]
    fn channel_modes_that_take_arguments_consume_them() {
        // `k` takes a parameter when set; `l` takes one only when set.
        let state = state_with(
            "me",
            &[
                ":s 353 me = #c :me",
                ":s MODE #c +kl secret 50",
                ":s MODE #c -l",
            ],
        );

        let channel = state.channel("#c").unwrap();
        assert_eq!(channel.modes.get(&'k'), Some(&Some("secret".to_owned())));
        // `-l` takes no argument, so it must not have eaten anything.
        assert_eq!(channel.modes.get(&'l'), None);
    }

    #[test]
    fn state_changes_name_the_affected_channel() {
        let mut state = state_with("me", &[":s 353 me = #c :me alice"]);
        let changes = state.apply(&message(":s MODE #c +o alice"));

        assert_eq!(changes, vec![StateChange::Channel("#c".to_owned())]);
    }
}
