import React from 'react';
import { Text } from 'react-native';

/**
 * Renders inline **bold** and *bold* segments as native bold Text nodes.
 */
export function FormattedChatText({ text, style, boldStyle }) {
  const raw = String(text ?? '');
  if (!raw) return null;

  const parts = [];
  const regex = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let lastIndex = 0;
  let match = regex.exec(raw);

  while (match) {
    if (match.index > lastIndex) {
      parts.push({ bold: false, text: raw.slice(lastIndex, match.index) });
    }
    parts.push({ bold: true, text: match[1] ?? match[2] ?? '' });
    lastIndex = regex.lastIndex;
    match = regex.exec(raw);
  }

  if (lastIndex < raw.length) {
    parts.push({ bold: false, text: raw.slice(lastIndex) });
  }

  if (parts.length === 0) {
    return <Text style={style}>{raw}</Text>;
  }

  return (
    <Text style={style}>
      {parts.map((part, index) =>
        part.bold ? (
          <Text key={`b-${index}`} style={boldStyle}>
            {part.text}
          </Text>
        ) : (
          <Text key={`n-${index}`}>{part.text}</Text>
        )
      )}
    </Text>
  );
}
