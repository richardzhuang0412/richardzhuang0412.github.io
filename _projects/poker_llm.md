---
layout: page
title: PokerBench
description: Can we train LLMs to become professional poker players?
img: assets/img/poker_llm.jpg
importance: 2
category: Ongoing
giscus_comments: false
---
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-R57GE0P1TR"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-R57GE0P1TR');
</script>

(Cover picture credit: [PokerBotAI](https://pokerbotai.com/our-news/mtt-poker-bot-ai-the-next-gen-poker-bot-enters-the-fray/))

*TL;DR: We tried to fine-tune an LLM using data from optimal poker strategy solver and found that with our current method it is unable to generalize to out-of-distribution scenarios :(*

The initial motivation of this project is to see language models can solve incomplete information games like poker through natural language. We formulate the problem in a distillation framework where we have sample strategies from a poker solver (which takes in a set of configuration of the game and outputs near optimal strategy for all nodes in the whole game tree) as the teacher and we let the LLM to learn this set of strategy through supervised fine-tuning, hoping that they learn a set of general principle that helps construct good strategies.

**Part 1: Benchmark Creation** (Warning: Poker Terminology Incoming)

The number of possible scenarios in poker is at the order of <a href='https://news.ycombinator.com/item?id=1409346'>1e18</a> even for 2-player game, and as number of players increase the game tree expands exponentially. To reduce the search space, we come up with an array of techniques to cluster similar scenarios together. This includes board classification, filtering of nodes in the game tree that are unlikely to happen, and narrowing down the space of available action (for instance discretizing the bet sizes into a number of choices). The goal of the dataset is to cover a wide range of scenarios using relatively small number of examples. We eventually get the number of representative scenarios down to 560,000 as our training set and we left out around 10,000 for evaluation.

**Part 2: Supervised Fine-Tuning**

Transforming each scenario to a natural language prompt, we perform supervised fine-tuning with the label being the optimal decision approved by our solver. We fine-tuned Gemma-2B, Llama-2-7B, and Llama-3-8B each for 10000 optimizer steps with a global batch size of 256 (about 4 epochs). We found that the test set accuracy rises significantly after fine-tuning.

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/poker_llm_1.png" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>
<div class="caption">
    Training curve for fine-tuning Llama-3-8B
</div>

**Part 3: Gameplay**

We then release our model into the wild by putting it into real gameplay with other traditional poker bots trained using Counterfactual Regret Minimization (CFR) algorithms. Unfortunately we found it is outplayed by those bots, indicating an inability to generalize to out-of-distribution scenarios.

**What's Next?**

Producing system that doesn't work is actually extremely valuable as it gives you an opportunity to step back and rethink aout your methodology, details in implementation, and even your motivation (won't go too much into this for now as I am STILL thinking lol). There are several directions that we can go, for example we can append external tools like hand equity calculators to the LLM (like how ChatGPT use programming languages to analyze results) or we can try starting with an easier goal of understanding/explaining poker concepts before going into gameplay. 

PS: Recently I went to Noam Brown‘s talk at BAIR and his presetation about the o1 model as well as the poker bots he created in the earlier days provides some valuable insights on shifting to **inference-time compute**. Let's see if I can come up with any new ideas that can hopefully get LLMs play good poker :)