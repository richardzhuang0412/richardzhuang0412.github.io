---
layout: page
title: LLM Collective Behaviors
description: What will happen if AI agents work as a group?
img: assets/img/ai_collective.jpg
importance: 4
category: Finished
---
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-R57GE0P1TR"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-R57GE0P1TR');
</script>

*TL;DR: Multi-agent systems could make the world better!*

In this project, we investigated the possibility of AI agents forming communities, as well as the consequence/characteristics of these so-called "free-formed AI collective". 

Our first experiment simulates a **"Cocktail Party"** between LLMs, where the goal is to let LLMs interact freely without humans assigning them specific roles or goals. Surprisingly, we found that the **agents formed tight-knit social circles**, preferring to talk to the same “friends” over time, just like humans. For close groups, their conversations even started to diverge, with different groups focusing on distinct topics and developing unique perspectives.

With confirmation that these agents form collectives, we continued to explore the **power of AI collectives**. After the "Cocktail Party", we provided them with a **creative sentence relay exercise**. The main finding is that collective responses are more novel than individual responses, suggesting that free-formed AI collectives offer unique opportunities for innovation.
<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/llm_collective_1.jpg" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>
Lastly we explored whether these AI collectives could regulate themselves and **prevent toxic behaviors from spreading**. We introduced malicious agents into the mix and play a **public good game** (kind of like Prisoner's Dilemma situation where the global optima differs from Nash Equilibrium outcome) to see if their behaviors would influence the others. Surprisingly, the AI collectives were pretty good at resisting bad behavior! In collective environments, AIs continued to cooperate and contribute positively, whereas isolated AIs were more likely to get poisoned.
<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/llm_collective_2.jpg" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>

And this is it! I think this opens up a lot of interesting question for future work in terms of the use of multi-agent systems. If you are interested, more details can be found <a href='https://arxiv.org/abs/2402.12590v2'>here</a>!




