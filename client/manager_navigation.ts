export type LogoutRoute = {
  endpoint: string;
  method: "GET" | "POST";
  destination: string;
};

async function primaryUrl(fetchFn: typeof fetch): Promise<string | undefined> {
  try {
    const response = await fetchFn("/.auth/central/public");
    if (!response.ok) return;
    const { primaryUrl } = await response.json();
    if (typeof primaryUrl !== "string") return;
    const url = new URL(primaryUrl);
    if (["https:", "http:"].includes(url.protocol) && url.origin === primaryUrl)
      return primaryUrl;
  } catch {}
}

export async function managerUrl(
  path = "",
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  return `${(await primaryUrl(fetchFn)) ?? ""}/.spaces${path}`;
}

export async function managerSessionRoutes(
  fetchFn: typeof fetch = fetch,
): Promise<{
  profile: string;
  logout: LogoutRoute;
}> {
  return (await primaryUrl(fetchFn))
    ? {
        profile: "/.auth/central/profile",
        logout: {
          endpoint: "/.auth/central/logout",
          method: "POST",
          destination: "/.auth/central/signed-out",
        },
      }
    : {
        profile: "/.spaces/api/profile",
        logout: {
          endpoint: "/.spaces/api/logout",
          method: "GET",
          destination: "/.spaces/login?signedOut=true",
        },
      };
}
