/**
 * omo public protocol version (plan §3.5, §6.3).
 *
 * Managed independently from upstream Session storage versions, omo data
 * versions and plugin SDK versions. Bumped only by an explicit protocol ADR;
 * clients and daemon negotiate before any subscription is installed.
 */
export const OMO_PROTOCOL_VERSION = 0;

/** Schema version of the command envelope payload wrapper itself. */
export const COMMAND_SCHEMA_VERSION = 1;

/** Schema version of the sync frame envelope. */
export const FRAME_SCHEMA_VERSION = 1;
