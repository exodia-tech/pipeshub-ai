"use client";

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

export function localDaypart(
  hour: number,
): "morning" | "afternoon" | "evening" | "night" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 22) return "evening";
  return "night";
}

export function WelcomeGreeting({ name }: { name?: string }) {
  const { t } = useTranslation();
  // A neutral first render keeps the static export independent of the build server's timezone.
  const [daypart, setDaypart] = useState<ReturnType<
    typeof localDaypart
  > | null>(null);
  useEffect(() => {
    const update = () => setDaypart(localDaypart(new Date().getHours()));
    update();
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  if (!daypart)
    return (
      <>{t("chat.heyUser", { name: name || t("chat.heyUserDefaultName") })}</>
    );
  return (
    <>{t(`chat.timeGreeting.${daypart}${name ? "Named" : ""}`, { name })}</>
  );
}
