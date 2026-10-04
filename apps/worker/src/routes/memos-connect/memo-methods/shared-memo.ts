import { getPublicShareByToken, listMemoReactions } from "@flaremo/domain";
import { currentMemoToDto } from "@flaremo/memos";
import { getFlareMoDb } from "../../../context";
import type { BinaryTransport } from "../../../memos-protobuf";
import { type ConnectContext, record, requiredString } from "../shared";
import { connectValue } from "../transport";

export async function connectGetSharedMemo(
  c: ConnectContext,
  value: unknown,
  transport?: BinaryTransport,
) {
  const body = record(value);
  const db = getFlareMoDb(c.env);
  const shared = await getPublicShareByToken(
    db,
    requiredString(body.shareId ?? body.shareToken, "shareId"),
  );
  const reactions = await listMemoReactions(db, shared.user, shared.memo.id, {
    pageSize: 1_000,
  });
  return connectValue(
    c,
    currentMemoToDto(shared.memo, shared.user, {
      attachments: shared.attachments,
      reactions: reactions.reactions,
    }),
    transport,
  );
}
