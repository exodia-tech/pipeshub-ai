"use client";

import React, { useEffect, useState } from "react";
import { Flex, IconButton, Text, VisuallyHidden } from "@radix-ui/themes";
import { useTranslation } from "react-i18next";

interface ChatCompanionProps {
  size?: number;
  variant?: "still" | "loader" | "thinking" | "listening";
  interactive?: boolean;
  showLabel?: boolean;
  style?: React.CSSProperties;
}

export function ChatCompanion({
  size = 32,
  variant = "still",
  interactive = false,
  showLabel = false,
  style,
}: ChatCompanionProps) {
  const { t } = useTranslation();
  const [greeting, setGreeting] = useState(false);
  useEffect(() => {
    if (!greeting) return;
    const timeout = window.setTimeout(() => setGreeting(false), 1200);
    return () => window.clearTimeout(timeout);
  }, [greeting]);
  const thinking = variant === "thinking" || variant === "loader";
  const face = (
    <svg
      width={size}
      height={size}
      viewBox="16 16 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={`chat-companion${thinking ? " chat-companion--thinking" : ""}${greeting ? " chat-companion--greeting" : ""}`}
      style={{ display: "inline-flex", flexShrink: 0, ...style }}
    >
      <g className="chat-companion__head">
        <g className="chat-companion__eyes" fill="var(--accent-11)">
          <ellipse
            cx={thinking ? 27 : 28}
            cy={thinking ? 32 : 35}
            rx="3"
            ry={variant === "listening" ? 6 : 4.5}
          />
          {greeting ? (
            <path
              d="M47 35 Q51 30 55 35"
              stroke="var(--accent-11)"
              strokeWidth="3.5"
              strokeLinecap="round"
              fill="none"
            />
          ) : (
            <ellipse
              cx={thinking ? 49 : 52}
              cy={thinking ? 32 : 35}
              rx="3"
              ry={variant === "listening" ? 6 : 4.5}
            />
          )}
        </g>
        <path
          d={
            greeting
              ? "M26 47 Q40 65 54 47"
              : thinking
                ? "M34 50 Q40 53 46 50"
                : "M28 47 Q40 60 52 47"
          }
          stroke="var(--accent-11)"
          strokeWidth="3.5"
          strokeLinecap="round"
          fill="none"
        />
      </g>
    </svg>
  );
  if (interactive)
    return (
      <>
        <IconButton
          type="button"
          variant="ghost"
          className="chat-companion-button"
          aria-label={t("chat.companion.sayHello")}
          onClick={() => setGreeting(true)}
          style={{
            width: Math.max(44, size),
            height: Math.max(44, size),
            margin: 0,
            borderRadius: "50%",
            cursor: "pointer",
          }}
        >
          {face}
        </IconButton>
        <VisuallyHidden>
          <span role="status">{greeting ? t("chat.companion.hello") : ""}</span>
        </VisuallyHidden>
      </>
    );
  if (!showLabel) return face;
  return (
    <Flex role="status" direction="column" align="center" gap="2">
      {face}
      <Text size="2" color="gray">
        {t("common.loading")}
      </Text>
    </Flex>
  );
}
