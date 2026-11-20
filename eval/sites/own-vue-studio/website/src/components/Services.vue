<script setup>
const services = [
  { title: 'Picture books', text: 'Full books from rough sketches to final art.' },
  { title: 'Editorial', text: 'Spot illustrations and covers for magazines.' },
  { title: 'Posters', text: 'Event and concert posters, printed or digital.' },
];
</script>

<template>
  <section class="services">
    <h2>What I make</h2>
    <article v-for="s in services" :key="s.title" class="card">
      <h3>{{ s.title }}</h3>
      <p>{{ s.text }}</p>
    </article>
  </section>
</template>
