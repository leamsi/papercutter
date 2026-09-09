import { expect, test } from "vitest";
import { managerUrl, managerSessionRoutes } from "./manager_navigation.ts";

const configured = async () =>
  new Response(JSON.stringify({ primaryUrl: "https://manage.example.test" }));
test("manager links use the configured primary origin", async () => {
  expect(await managerUrl("/profile", configured)).toBe(
    "https://manage.example.test/.spaces/profile",
  );
});
test("legacy deployments retain origin-relative manager links", async () => {
  expect(
    await managerUrl("", async () => new Response("", { status: 404 })),
  ).toBe("/.spaces");
});
test("isolated space session operations stay on the space origin", async () => {
  expect(await managerSessionRoutes(configured)).toEqual({
    profile: "/.auth/central/profile",
    logout: {
      endpoint: "/.auth/central/logout",
      method: "POST",
      destination: "/.auth/central/signed-out",
    },
  });
});
