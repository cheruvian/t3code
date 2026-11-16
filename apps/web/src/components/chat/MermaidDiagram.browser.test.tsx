import { Suspense } from "react";
import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { MermaidDiagram } from "./MermaidDiagram";

it("renders real diagrams and recovers after invalid source", async () => {
  await using screen = await render(null, { router: false });
  const container = screen.container;
  const source = "flowchart LR\nA[Start] --> B[Finish]";
  const renderDiagram = (code: string, both = false) =>
    screen.rerender(
      <Suspense fallback={<p>Rendering</p>}>
        <MermaidDiagram source={code} onExpand={() => {}} />
        {both ? <MermaidDiagram source={code} onExpand={() => {}} /> : null}
      </Suspense>,
    );

  await renderDiagram(source, true);
  await expect.poll(() => container.querySelectorAll("svg").length).toBe(2);
  const diagrams = [...container.querySelectorAll("svg")];
  expect(diagrams.map((diagram) => diagram.textContent)).toEqual([
    expect.stringContaining("Start"),
    expect.stringContaining("Finish"),
  ]);
  const firstIds = new Set([...diagrams[0]!.querySelectorAll("[id]")].map((element) => element.id));
  expect(
    [...diagrams[1]!.querySelectorAll("[id]")].some((element) => firstIds.has(element.id)),
  ).toBe(false);

  await renderDiagram("not a diagram");
  await expect.poll(() => container.textContent).toContain("Unable to render diagram");
  expect(container.querySelector("pre")?.textContent).toBe("not a diagram");

  await renderDiagram("sequenceDiagram\nAlice->>Bob: Hello");
  await expect.poll(() => container.querySelector("svg")?.textContent).toContain("Hello");
  expect(container.textContent).not.toContain("Unable to render diagram");
  expect(document.querySelectorAll('[id^="dmermaid-diagram-"]')).toHaveLength(0);
});
