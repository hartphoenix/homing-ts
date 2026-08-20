import { Route, Routes } from "react-router";

function Foundation() {
  return (
    <main className="foundation">
      <section>
        <p className="eyebrow">Homing</p>
        <h1>A shared place for the search.</h1>
        <p>
          The TypeScript replacement is being built against Homing’s agent and collaboration
          contract.
        </p>
      </section>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="*" element={<Foundation />} />
    </Routes>
  );
}
