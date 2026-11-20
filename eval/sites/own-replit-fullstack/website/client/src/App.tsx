import Hero from "./components/Hero";
import Projects from "./components/Projects";

export default function App() {
  return (
    <main className="max-w-3xl mx-auto px-6">
      <Hero />
      <Projects />
      <footer className="py-10 text-sm text-gray-500">Built on Replit. Last updated October 2026.</footer>
    </main>
  );
}
