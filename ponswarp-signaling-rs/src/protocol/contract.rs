//! Immutable v1 protocol fixtures and drift tests.
//!
//! The fixture is deliberately kept outside the Rust crate so it can also be
//! consumed by the TypeScript implementation. These tests only exercise the
//! existing wire types; they do not define a second protocol representation.

#[cfg(test)]
use serde::Deserialize;
#[cfg(test)]
use serde_json::Value;

pub const V1_MESSAGES_FIXTURE: &str = include_str!("../../../contracts/protocol/v1/messages.json");

#[cfg(test)]
#[derive(Debug, Deserialize)]
struct ContractFixture {
    version: String,
    room_code: String,
    client_messages: Vec<Value>,
    server_messages: Vec<Value>,
    data_channel_payloads: DataChannelPayloads,
}

#[cfg(test)]
#[derive(Debug, Deserialize)]
struct DataChannelPayloads {
    control: Vec<Value>,
    ack: Vec<Value>,
    resume: Vec<Value>,
    complete: Vec<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ClientMessage, ServerMessage};

    fn fixture() -> ContractFixture {
        serde_json::from_str(V1_MESSAGES_FIXTURE).expect("v1 fixture must be valid JSON")
    }

    #[test]
    fn v1_fixture_is_versioned_and_covers_room_and_data_channel_shapes() {
        let fixture = fixture();
        assert_eq!(fixture.version, "v1");
        assert!(fixture.room_code.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(fixture.room_code.len(), 6);
        assert_eq!(fixture.data_channel_payloads.control.len(), 3);
        assert_eq!(fixture.data_channel_payloads.ack.len(), 1);
        assert_eq!(fixture.data_channel_payloads.resume.len(), 1);
        assert_eq!(fixture.data_channel_payloads.complete.len(), 1);
    }

    #[test]
    fn v1_client_fixtures_round_trip_without_wire_drift() {
        let fixture = fixture();
        assert_eq!(fixture.client_messages.len(), 12);

        for expected in fixture.client_messages {
            let decoded: ClientMessage =
                serde_json::from_value(expected.clone()).expect("client fixture must parse");
            let encoded = serde_json::to_value(decoded).expect("client fixture must serialize");
            assert_eq!(encoded, expected);
        }
    }

    #[test]
    fn v1_server_fixtures_round_trip_without_wire_drift() {
        let fixture = fixture();
        assert_eq!(fixture.server_messages.len(), 16);

        for expected in fixture.server_messages {
            let decoded: ServerMessage =
                serde_json::from_value(expected.clone()).expect("server fixture must parse");
            let encoded = serde_json::to_value(decoded).expect("server fixture must serialize");
            assert_eq!(encoded, expected);
        }
    }
}
