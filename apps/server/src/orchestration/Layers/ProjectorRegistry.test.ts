import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  defineProjector,
  orderProjectors,
  ProjectorDependencyError,
  type ProjectorDefinition,
} from "./ProjectorRegistry.ts";

const projector = (name: string, reads: ReadonlyArray<string> = []): ProjectorDefinition =>
  defineProjector({
    name,
    reads,
    on: {
      "thread.message-sent": () => Effect.void,
    },
  });

const names = (definitions: ReadonlyArray<ProjectorDefinition>) =>
  definitions.map((definition) => definition.name);

describe("orderProjectors", () => {
  it("runs a projector after every projector it reads", () => {
    const ordered = orderProjectors([
      projector("threads", ["thread-messages", "pending-approvals"]),
      projector("thread-messages"),
      projector("pending-approvals"),
    ]);

    const order = names(ordered);
    assert.isAbove(order.indexOf("threads"), order.indexOf("thread-messages"));
    assert.isAbove(order.indexOf("threads"), order.indexOf("pending-approvals"));
  });

  it("keeps declaration order for independent projectors", () => {
    const ordered = orderProjectors([
      projector("projects"),
      projector("thread-messages"),
      projector("thread-activities"),
    ]);

    assert.deepEqual(names(ordered), ["projects", "thread-messages", "thread-activities"]);
  });

  it("orders a transitive chain", () => {
    const ordered = orderProjectors([projector("c", ["b"]), projector("b", ["a"]), projector("a")]);

    assert.deepEqual(names(ordered), ["a", "b", "c"]);
  });

  it("rejects a dependency cycle", () => {
    assert.throws(
      () => orderProjectors([projector("a", ["b"]), projector("b", ["a"])]),
      ProjectorDependencyError,
    );
  });

  it("rejects a projector that reads itself", () => {
    assert.throws(() => orderProjectors([projector("a", ["a"])]), ProjectorDependencyError);
  });

  it("rejects an unknown dependency", () => {
    assert.throws(() => orderProjectors([projector("a", ["missing"])]), ProjectorDependencyError);
  });

  it("rejects duplicate projector names", () => {
    assert.throws(
      () => orderProjectors([projector("a"), projector("a")]),
      ProjectorDependencyError,
    );
  });
});
