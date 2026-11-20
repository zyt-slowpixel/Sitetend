const projects = [
  { name: "Corner Store Inventory", description: "A barcode inventory app for my uncle's grocery store.", tech: "React, Express, SQLite" },
  { name: "Bus Buddy", description: "Text alerts when the DDOT bus is five minutes away.", tech: "Node, Twilio" },
];

export default function Projects() {
  return (
    <section className="py-10">
      <h2 className="text-2xl font-semibold">Projects</h2>
      <ul className="mt-4 space-y-4">
        {projects.map((p) => (
          <li key={p.name}>
            <h3 className="font-medium">{p.name}</h3>
            <p>{p.description}</p>
            <p className="text-sm text-gray-500">{p.tech}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
