/**
 * Memo payload construction shared by the current REST and Connect Memos
 * surfaces. Both surfaces previously carried their own `currentPayload`
 * copy, and the copies had drifted: the Connect copy stored the incoming
 * `property` object verbatim (camelCase keys included), while the current
 * copy normalized it onto the snake_case payload keys the domain layer and
 * the protobuf codecs read back. Every surface now writes the canonical
 * normalized shape, so a property created through any compat surface reads
 * back through all of them.
 */
import { isRecord } from "./errors";

export type CompatMemoPayloadInput = {
  payload?: unknown;
  tags?: unknown;
  property?: unknown;
  location?: unknown;
};

export function compatMemoPayload(
  input: CompatMemoPayloadInput,
): Record<string, unknown> {
  const payload = { ...record(input.payload) };
  if (Array.isArray(input.tags)) payload.tags = input.tags;
  if (isRecord(input.property)) {
    const property = input.property as Record<string, unknown>;
    payload.property = {
      ...(typeof property.title === "string" ? { title: property.title } : {}),
      ...(typeof property.hasLink === "boolean"
        ? { has_link: property.hasLink }
        : {}),
      ...(typeof property.hasTaskList === "boolean"
        ? { has_task_list: property.hasTaskList }
        : {}),
      ...(typeof property.hasCode === "boolean"
        ? { has_code: property.hasCode }
        : {}),
      ...(typeof property.hasIncompleteTasks === "boolean"
        ? { has_incomplete_tasks: property.hasIncompleteTasks }
        : {}),
    };
  }
  if (isRecord(input.location)) payload.location = input.location;
  return payload;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
