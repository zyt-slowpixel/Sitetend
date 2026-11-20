<script setup>
import Hero from './components/Hero.vue';
import Services from './components/Services.vue';
const contact = { email: 'hello@mirastudio.example', city: 'Columbus, Ohio' };
</script>

<template>
  <Hero />
  <Services />
  <footer class="site-footer">
    <p>Write to me at <a :href="'mailto:' + contact.email">{{ contact.email }}</a></p>
    <p>Based in {{ contact.city }}. Commissions open for spring.</p>
  </footer>
</template>

<style scoped>
.site-footer { padding: 2rem; }
</style>
