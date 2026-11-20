import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const collections = [
  { title: "Tide Bowls", description: "Shallow bowls glazed in sea-green celadon." },
  { title: "Morning Mugs", description: "Wide mugs that fit two hands on a cold morning." },
  { title: "Bud Vases", description: "Small vases for a single stem from the garden." },
];

export default function Home() {
  return (
    <main className="container mx-auto px-4 py-16">
      <section className="text-center space-y-4">
        <h1 className="text-5xl font-semibold tracking-tight">Hana Sato Ceramics</h1>
        <p className="text-muted-foreground text-lg">Hand-thrown stoneware made in a small studio in Portland, Oregon.</p>
        <Button size="lg">Shop the spring collection</Button>
      </section>
      <section className="grid md:grid-cols-3 gap-6 mt-16">
        {collections.map((c) => (
          <Card key={c.title}>
            <CardHeader><CardTitle>{c.title}</CardTitle></CardHeader>
            <CardContent className="text-muted-foreground">{c.description}</CardContent>
          </Card>
        ))}
      </section>
      <section className="mt-16 text-center">
        <h2 className="text-2xl font-medium">Studio hours</h2>
        <p className="mt-2">Open studio every first Saturday, 10am to 4pm.</p>
      </section>
    </main>
  );
}
