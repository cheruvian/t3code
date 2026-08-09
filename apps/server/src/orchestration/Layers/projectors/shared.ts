/**
 * Helpers shared by more than one projector.
 *
 * @module projectors/shared
 */
import { ApprovalRequestId } from "@t3tools/contracts";

export function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}
