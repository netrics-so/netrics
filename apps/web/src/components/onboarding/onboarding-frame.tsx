"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { useT } from "@/lib/i18n/client";
import { onboardingRail, type OnboardingStep } from "@/lib/onboarding";

/**
 * First-run onboarding (#308, design 1e): the 260 px step rail on paper
 * (done = filled accent circle with a check, current = accent ring, next =
 * neutral ring) beside the current step on white. Full screen, without the
 * app shell: the user has nothing to navigate to yet.
 */
export function OnboardingFrame({
  step,
  children,
}: {
  step: OnboardingStep;
  children: ReactNode;
}) {
  const t = useT("onboarding");
  return (
    <div className="onboarding">
      <aside className="onboarding-rail">
        <Link href="/" className="onboarding-brand">
          <span className="brand-dot" aria-hidden="true" />
          netrics
        </Link>
        <p className="onboarding-tagline">{t("tagline")}</p>
        <ol className="onboarding-steps" aria-label={t("stepsLabel")}>
          {onboardingRail(step).map((item) => (
            <li
              key={item.step}
              className={`onboarding-step ${item.state}`}
              aria-current={item.state === "current" ? "step" : undefined}
            >
              <span className="onboarding-step-mark" aria-hidden="true">
                {item.state === "done" ? "✓" : item.number}
              </span>
              {t(`steps.${item.step}`)}
              {item.state === "done" ? (
                <span className="visually-hidden"> {t("done")}</span>
              ) : null}
            </li>
          ))}
        </ol>
        <p className="onboarding-rail-note">{t("railNote")}</p>
      </aside>
      <main id="main" className="onboarding-main">
        {children}
      </main>
    </div>
  );
}
