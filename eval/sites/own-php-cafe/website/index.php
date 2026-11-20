<?php
$cafe = [
  'name' => 'Little Fern Café',
  'tagline' => 'Coffee, soup and quiet tables in Ypsilanti.',
  'hours' => 'Open Tuesday to Sunday, 7am to 3pm',
];
$menu = [
  ['item' => 'House drip coffee', 'price' => '$3', 'note' => 'Roasted by Ruth Roasters in Detroit'],
  ['item' => 'Tomato basil soup', 'price' => '$7', 'note' => 'Made fresh every morning'],
  ['item' => 'Cardamom bun', 'price' => '$4', 'note' => 'Our most popular pastry'],
];
include 'header.php';
?>
<main>
  <section class="hero">
    <h1><?= $cafe['name'] ?></h1>
    <p><?= $cafe['tagline'] ?></p>
    <p class="hours"><?= $cafe['hours'] ?></p>
  </section>
  <section id="menu">
    <h2>Today's menu</h2>
    <ul>
      <?php foreach ($menu as $m): ?>
        <li><strong><?= $m['item'] ?></strong> <?= $m['price'] ?> <em><?= $m['note'] ?></em></li>
      <?php endforeach; ?>
    </ul>
  </section>
  <section id="visit">
    <h2>Visit us</h2>
    <p>214 West Cross Street, Ypsilanti, MI 48197</p>
    <p>Call us at (734) 555-0142 or write to hello@littlefern.example</p>
  </section>
</main>
<?php include 'footer.php'; ?>
