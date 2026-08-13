/**
 * In-process delivery for transient assistant previews.
 *
 * Preview events never enter orchestration persistence. Each subscription sees
 * only publications made while it is attached.
 *
 * @module AssistantPreviewBus
 */
import type { OrchestrationAssistantPreview, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export interface AssistantPreviewPublication {
  readonly threadId: ThreadId;
  readonly preview: OrchestrationAssistantPreview;
}

export interface AssistantPreviewBusShape {
  readonly publish: (publication: AssistantPreviewPublication) => Effect.Effect<void>;
  readonly stream: Stream.Stream<AssistantPreviewPublication>;
}

export class AssistantPreviewBus extends Context.Service<
  AssistantPreviewBus,
  AssistantPreviewBusShape
>()("t3/orchestration/Services/AssistantPreviewBus") {}
