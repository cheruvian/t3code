import * as Tracer from "effect/Tracer";
import { expect, it } from "vite-plus/test";

import * as ClientTracer from "~/observability/clientTracer";
import { observeBrowserHostGate } from "./browserAttachmentTelemetry";

it("replays only the current host gate when tracing becomes ready and disposes it", () => {
  const spans: Tracer.Span[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  ClientTracer.setDelegate(null);
  const stopUnknown = observeBrowserHostGate({
    environmentId: "none",
    configKnown: false,
    hostsPrimary: false,
  });
  stopUnknown();
  const stopKnown = observeBrowserHostGate({
    environmentId: "environment",
    configKnown: true,
    hostsPrimary: true,
  });
  try {
    expect(spans).toHaveLength(0);
    ClientTracer.setDelegate(tracer);
    expect(spans).toHaveLength(1);
    expect(Object.fromEntries(spans[0]!.attributes)).toEqual({
      environmentId: "environment",
      configKnown: true,
      hostsPrimary: true,
      replay: true,
    });
    ClientTracer.setDelegate(tracer);
    expect(spans).toHaveLength(1);
    stopKnown();
    ClientTracer.setDelegate(null);
    ClientTracer.setDelegate(tracer);
    expect(spans).toHaveLength(1);
  } finally {
    stopKnown();
    ClientTracer.setDelegate(null);
  }
});
