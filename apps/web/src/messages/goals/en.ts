/**
 * The Goals page (ADR 0019 section 4, #335): goals with their progress, and
 * the goal form the Studio's gauge picker reuses (#339).
 */
export const goalsEn = {
  goals: {
    metaTitle: "Goals · netrics",
    title: "Goals",
    meta: "{count, plural, =0 {No goals yet} one {# goal} other {# goals}}",
    metaReached:
      "{count, plural, one {# goal} other {# goals}} · {reached} reached",
    newGoal: "New goal",
    list: "Your goals",
    empty: {
      title: "No goals yet",
      text: "A goal is a target for one metric in a period, such as 15,000 downloads this month. Gauges on your dashboards show how far along it is.",
      readOnly: "Editors, admins and owners can add goals.",
    },
    noMetrics:
      "None of your sources has a metric a goal can follow yet. Connect a source first.",
    period: "Period",
    progressLabel: "{name}: {percent} of the target",
    valueOfTarget: "{value} of {target}",
    toGo: "{amount} to go",
    reached: "Reached",
    reachedOn: "Reached on {date}",
    noData: "No data in this period yet",
    unavailable: "Progress cannot be read right now",
    approximate: "Approximate: converted at ECB reference rates",
    edit: "Edit",
    editNamed: "Edit {name}",
    delete: "Delete",
    deleteNamed: "Delete {name}",
    confirmDelete: "Delete “{name}”?",
    usedOn:
      "{count, plural, one {Used on # dashboard: {names}.} other {Used on # dashboards: {names}.}} Gauges there then show “Goal deleted”.",
    notUsed: "No dashboard shows it.",
    deleteConfirmed: "Delete goal",
    form: {
      createTitle: "New goal",
      editTitle: "Edit goal",
      name: "Name",
      namePlaceholder: "Monthly downloads",
      target: "Target",
      targetHelp: "What the metric should reach by the end of each period.",
      targetHelpLast:
        "What the metric's latest value should reach within each period.",
      targetInvalid: "Enter a target above zero.",
      create: "Create goal",
      save: "Save goal",
      versionConflict:
        "Someone else changed this goal in the meantime. Reload the page to see their changes.",
    },
  },
} as const;
