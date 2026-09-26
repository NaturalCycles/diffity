import { useRouteError } from "react-router";
import type { Route } from "./+types/diff";
import { queryClient } from "../lib/query-client";
import { diffOptions } from "../queries/diff";
import { repoInfoOptions } from "../queries/info";
import { DiffPage } from "../components/diff/diff-page";
import { ErrorPage } from "../components/error-page";

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  const theme = url.searchParams.get("theme") as "light" | "dark" | null;
  const view = url.searchParams.get("view") as "split" | "unified" | null;

  await Promise.all([
    queryClient.ensureQueryData(diffOptions(false)),
    queryClient.ensureQueryData(repoInfoOptions()),
  ]);

  return { theme, view };
}

export default function DiffRoute({ loaderData }: Route.ComponentProps) {
  return <DiffPage />;
}

export function ErrorBoundary() {
  const error = useRouteError();

  return (
    <ErrorPage
      error={error}
      actions={[
        { label: "Reload page", primary: true, onClick: () => window.location.reload() },
      ]}
    />
  );
}
