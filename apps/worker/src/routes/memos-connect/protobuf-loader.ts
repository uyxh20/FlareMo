/**
 * Lazy accessor for the generated @bufbuild/protobuf descriptor runtime.
 *
 * The generated set in memos-generated/ plus the @bufbuild runtime behind it is
 * by far the largest subtree the Connect protocol pulls in, and every one of
 * its consumers (`transport.ts` for the response encoder and the JSON
 * normalizer, `connect/binary-body.ts` for the request decoder) sits on a path
 * the isolate executes only when a Connect RPC is actually served. Importing
 * it statically therefore pinned ~360 KiB of descriptor code into the startup
 * graph of every isolate, including the ones that only ever serve the web app
 * and the REST adapter — the web frontend never speaks Connect.
 *
 * Keeping the import dynamic holds the cost to the first Connect request and
 * memoizes it afterwards, so at most one extra promise chain is paid per
 * isolate. Only callers that are already async may await this: the Connect
 * framing itself never needed to be encoded synchronously, but the media-type
 * gate, the 415 rejection, and the error envelope must stay synchronous, which
 * is why those live in memos-compat/proto-wire.ts instead.
 */

type MemosProtobuf = typeof import("../../memos-protobuf");

let codec: Promise<MemosProtobuf> | undefined;

export function loadMemosProtobuf(): Promise<MemosProtobuf> {
  if (!codec) codec = import("../../memos-protobuf");
  return codec;
}
