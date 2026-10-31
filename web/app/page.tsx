import { Suspense } from "react";
import { ArenaApp } from "../components/ArenaApp";

export default function Page() {
  return (
    <Suspense fallback={<main className="shell"><p>Loading arena…</p></main>}>
      <ArenaApp />
    </Suspense>
  );
}
