// Compact JSON input that expands into a lightweight mini editor on focus.
// Plain textarea when collapsed (38px single line); syntax-highlighted overlay,
// auto-closing brackets and one-click formatting when expanded.
import { useEffect, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { Button, Tooltip } from "antd";
import { ChevronDown, ChevronUp, WandSparkles } from "lucide-react";

interface JsonMiniEditorProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Aggregate pipeline is an array; formatting still works the same. */
  arrayMode?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  compactRows?: number;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\$[A-Za-z]+)/g;

function highlightJson(text: string): string {
  let out = "";
  let last = 0;
  let match: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, match.index));
    if (match[1]) {
      const cls = match[2] ? "jmk-key" : "jmk-str";
      out += `<span class="${cls}">${escapeHtml(match[1])}</span>` + escapeHtml(match[2] ?? "");
    } else if (match[3]) out += `<span class="jmk-bool">${match[3]}</span>`;
    else if (match[4]) out += `<span class="jmk-num">${match[4]}</span>`;
    else if (match[5]) out += `<span class="jmk-op">${match[5]}</span>`;
    last = TOKEN.lastIndex;
  }
  out += escapeHtml(text.slice(last));
  return out + "\n";
}

export default function JsonMiniEditor({
  label, value, onChange, placeholder, arrayMode = false,
  expanded: controlledExpanded, onExpandedChange, compactRows = 1,
}: JsonMiniEditorProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  function setExpanded(next: boolean) {
    if (controlledExpanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
    if (next) requestAnimationFrame(() => areaRef.current?.focus());
  }

  useEffect(() => {
    if (expanded && areaRef.current) {
      const len = areaRef.current.value.length;
      areaRef.current.setSelectionRange(len, len);
    }
  }, [expanded]);

  function format() {
    try {
      const parsed: unknown = JSON.parse(value);
      onChange(JSON.stringify(parsed, null, 2));
    } catch {
      // Leave invalid JSON untouched — the query will report the parse error.
    }
  }

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    if (preRef.current) {
      preRef.current.scrollTop = event.currentTarget.scrollTop;
      preRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const area = event.currentTarget;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);
    const key = event.key;
    const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")", '"': '"' };
    if (pairs[key]) {
      event.preventDefault();
      const inserted = key + pairs[key];
      const next = before + inserted + after;
      onChange(next);
      requestAnimationFrame(() => area.setSelectionRange(start + 1, start + 1));
      return;
    }
    if ((key === "}" || key === "]" || key === ")" || key === '"') && after.startsWith(key)) {
      event.preventDefault();
      area.setSelectionRange(start + 1, start + 1);
      return;
    }
    if (key === "Backspace" && start === end && pairs[before.slice(-1)] === after[0]) {
      event.preventDefault();
      const next = value.slice(0, start - 1) + value.slice(end + 1);
      onChange(next);
      requestAnimationFrame(() => area.setSelectionRange(start - 1, start - 1));
      return;
    }
    if (key === "Enter") {
      event.preventDefault();
      const lineStart = before.lastIndexOf("\n") + 1;
      const indent = (before.slice(lineStart).match(/^\s*/)?.[0] ?? "") + "  ";
      const closing = after.trimStart()[0] === "}" || after.trimStart()[0] === "]";
      const insert = "\n" + indent + (closing ? "\n" + indent.slice(0, -2) : "");
      const next = before + insert + after;
      onChange(next);
      const cursor = start + insert.length - (closing ? indent.length - 2 + 1 : 0);
      requestAnimationFrame(() => area.setSelectionRange(cursor, cursor));
    }
  }

  const lines = value.split("\n").length;
  return (
    <div className={`json-mini ${expanded ? "json-mini-expanded" : ""}`}>
      <div className="json-mini-head">
        <span className="json-mini-label">{label}</span>
        <span className="json-mini-head-actions">
          {expanded && (
            <Tooltip title="格式化 JSON">
              <Button type="text" size="small" icon={<WandSparkles size={13} />} onClick={format}>格式化</Button>
            </Tooltip>
          )}
          <Tooltip title={expanded ? "收起编辑器" : "展开编辑器"}>
            <Button
              type="text"
              size="small"
              icon={expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
              onClick={() => setExpanded(!expanded)}
              aria-label={expanded ? "收起编辑器" : "展开编辑器"}
            />
          </Tooltip>
        </span>
      </div>
      <div className="json-mini-body" onClick={() => { if (!expanded) setExpanded(true); }}>
        {expanded && <pre ref={preRef} className="json-mini-highlight" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlightJson(value) }} />}
        <textarea
          ref={areaRef}
          className="json-mini-input"
          rows={expanded ? Math.max(6, Math.min(lines + 1, 18)) : compactRows}
          value={value}
          spellCheck={false}
          placeholder={placeholder ?? (arrayMode ? '[{"$match":{}}]' : "{}")}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={syncScroll}
          onFocus={() => { if (!expanded) setExpanded(true); }}
        />
      </div>
    </div>
  );
}
