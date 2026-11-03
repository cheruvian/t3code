import * as Effect from "effect/Effect";

import * as ClientTracer from "~/observability/clientTracer";

export function recordBrowserAttachment(
  stage: string,
  attributes: Record<string, string | number | boolean>,
): void {
  Effect.runSync(
    Effect.void.pipe(
      Effect.withSpan(`browser.attachment.${stage}`, { attributes }),
      Effect.provide(ClientTracer.layer),
    ),
  );
}
