import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiError, apiErrorMessage } from "./api";

describe("apiErrorMessage", () => {
  it("words API error codes in the user's language", () => {
    const error = new ApiError(409, "last_owner");
    expect(apiErrorMessage(error, "en")).toBe(
      "The last owner of a workspace cannot be demoted or removed.",
    );
    expect(apiErrorMessage(error, "de")).toBe(
      "Der letzte Inhaber eines Workspaces kann weder herabgestuft noch entfernt werden.",
    );
  });

  it("shares one message between codes that mean the same", () => {
    expect(apiErrorMessage(new ApiError(404, "project_not_found"), "en")).toBe(
      "That record no longer exists.",
    );
    expect(
      apiErrorMessage(new ApiError(415, "unsupported_media_type"), "de"),
    ).toBe("Diese Datei ist kein PNG-, JPEG- oder WebP-Bild.");
  });

  it("names the dashboards that still use a theme", () => {
    const error = new ApiError(409, "theme_in_use", {
      dashboards: [
        { id: "a", name: "Sales" },
        { id: "b", name: "Ops" },
      ],
    } as never);
    expect(apiErrorMessage(error, "en")).toBe(
      "Dashboards still use this theme: Sales and Ops. Pick another theme for them first.",
    );
    expect(apiErrorMessage(error, "de")).toBe(
      "Diese Dashboards verwenden das Design noch: Sales und Ops. Wähl zuerst ein anderes Design für sie.",
    );
    expect(apiErrorMessage(new ApiError(409, "theme_in_use"), "en")).toBe(
      "Dashboards still use this theme. Pick another theme for them first.",
    );
  });

  it("shows an unknown code, and a connector's own message as it is", () => {
    expect(apiErrorMessage(new ApiError(500, "brand_new_code"), "de")).toBe(
      "Anfrage fehlgeschlagen (brand_new_code).",
    );
    expect(
      apiErrorMessage(new ApiError(400, "The token was rejected."), "de"),
    ).toBe("The token was rejected.");
  });

  it("words invalid input and other failures", () => {
    const zod = z.object({ name: z.string() }).safeParse({}).error;
    expect(apiErrorMessage(zod, "de")).toBe(
      "Prüf deine Eingaben – ein Feld fehlt oder ist ungültig.",
    );
    expect(apiErrorMessage("nope", "en")).toBe("Something went wrong.");
    expect(apiErrorMessage(new Error("offline"), "en")).toBe("offline");
  });
});
