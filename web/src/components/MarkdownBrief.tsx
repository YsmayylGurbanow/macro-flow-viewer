import React from "react";

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((segment, index) => {
    if (segment.startsWith("**") && segment.endsWith("**")) {
      return (
        <strong key={index} className="font-semibold text-[#1C1610]">
          {segment.slice(2, -2)}
        </strong>
      );
    }
    if (segment.startsWith("`") && segment.endsWith("`")) {
      return (
        <code
          key={index}
          className="rounded-sm border border-[#C8B9A0] bg-[#EFE4CC] px-1.5 py-0.5 font-mono text-xs text-[#2B5B6C]"
        >
          {segment.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={index}>{segment}</React.Fragment>;
  });
}

export function MarkdownBrief({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/);

  return (
    <div className="space-y-2.5 font-serif text-[15px] leading-relaxed text-[#1C1610]">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trim();
        if (!line) {
          return <div key={idx} className="h-1" />;
        }
        if (line.startsWith("## ")) {
          return (
            <h3
              key={idx}
              className="border-b border-[#C8B9A0] pb-1.5 font-display text-lg font-semibold tracking-wide text-[#1C1610]"
            >
              {renderInlineMarkdown(line.slice(3))}
            </h3>
          );
        }
        if (line.startsWith("### ")) {
          return (
            <h4
              key={idx}
              className="pt-2 font-display text-xs font-bold uppercase tracking-[0.16em] text-[#9E2A2B]"
            >
              {renderInlineMarkdown(line.slice(4))}
            </h4>
          );
        }
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <div key={idx} className="flex items-start gap-2.5 pl-1">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rotate-45 bg-[#B5892E]" />
              <p className="flex-1 text-[#1C1610]">
                {renderInlineMarkdown(line.slice(2))}
              </p>
            </div>
          );
        }
        return (
          <p key={idx} className="text-[#1C1610]">
            {renderInlineMarkdown(line)}
          </p>
        );
      })}
    </div>
  );
}
