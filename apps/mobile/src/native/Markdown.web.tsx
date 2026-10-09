import type { ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { Markdown as NativeMarkdown } from "react-native-nitro-markdown";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

const components: Components = {
  a: ({ node: _node, ...link }) => <a {...link} target="_blank" rel="noopener noreferrer" />,
};

// Browser rendering replaces Nitro's native parser and view implementation.
export function Markdown(props: ComponentProps<typeof NativeMarkdown>) {
  return <ReactMarkdown components={components}>{props.children}</ReactMarkdown>;
}

export function getTextContent(node: MarkdownNode): string {
  return node.content || node.children?.map(getTextContent).join("") || "";
}
