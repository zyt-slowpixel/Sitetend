<script>
  import { shows, band } from '$lib/shows.js';
</script>

<svelte:head>
  <title>The Low Tides - surf rock from Michigan</title>
</svelte:head>

<header>
  <h1>{band.name}</h1>
  <p>{band.bio}</p>
</header>

<section>
  <h2>Upcoming shows</h2>
  <ul>
    {#each shows as s}
      <li>{s.date} - {s.venue}, {s.city}</li>
    {/each}
  </ul>
</section>

<section>
  <h2>New record</h2>
  <p>Our second album, Saltwater Static, comes out on vinyl this winter.</p>
  <p>For booking, write to <a href="mailto:{band.booking}">{band.booking}</a>.</p>
</section>

<style>
  header { text-align: center; }
</style>
