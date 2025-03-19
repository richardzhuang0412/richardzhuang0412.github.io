---
layout: page
title: VirusSim
description: Plague Inc. style simulation for hospitalized associated infections
img: assets/img/hai_simulation.jpg
# redirect: https://unsplash.com
importance: 3
category: Ongoing
---
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-R57GE0P1TR"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-R57GE0P1TR');
</script>

The problem we (shout out to my GREAT project partner and roommate [Haojun Zhuang](https://haojun.me)) targeted to solve in this project is modeling disease transmission within hospitalized settings. There are two main traditional approaches: mechanistic, compartmental models like [SEIR](https://en.wikipedia.org/wiki/Compartmental_models_in_epidemiology) models that use PDEs to describe the relationship between variables involved in the transmission, or Monte-Carlo based simulations like ours.

**Part 1: Construct simulation**

We established an agent-based simulation where patients moved around departments of the hospital and disease is either imported as they enter the hospital or probablistically spreaded between initial carriers and their wardmates. To align our simulation better with the real-world scenarios, we consult with medical professionals to implement a more realistic pipeline where patients go through several states as they are exposed to the disease (colonized, symptomatic, contagious etc.). We also incorporate an observational layer by adding a realistic testing procedures into the simulation.

**Part 2: Movement pattern generation**

So how do patients move around? Random movement is definitely too naive as there is actually a lot of dependencies from the movement pattern (e.g. if a patient has been to Gastroenterology department it is likely that they will go to the room for stool test), yet for us there is only one set of patient movement data. To augment our movement data for more diverse simulations, we propose a hierachical "generative" model. Essentially we break the movement data into: \\
\\
    1. Number of new patients per day \\
    2. Duration of staying of each patient \\
    3. The specific path of departments they visit during the stay \\
\\
and model each one individually in order. 

For the first two we fit different distribution like Gaussian/LogNormal to the original data and sample from that distribution during generation (the actual implementation is a bit more complicated as we also consider weekend-weekday effect and model the two separately but the idea is the same). For the third component we formulate the path as a Discrete-Time Markov Chain and sample from that chain.

**Current: Image reconstruction through deep learning**

So what's next? With the above setups, we realized that we actually have an infinite amount of snapshots available (movement generation + Monte-Carlo simulation) of both an omniscient/full observation (ground truth patient status stored in our simulation) and a partial observation (through the testing procedure). 

And this is where we thought deep learning could kick in. If we could represent both observations as some vectors/matrices we could train an image reconstruction network to transform one into another. The value of this lies in the fact that all real-world data are partial observations, so even if we have a perfect simulator we would have to have at least one omniscient snapshot for it to produce forecasts. 

How do we represent all information at a given time in the hospital though? Currently, the representation we've come up with is an image-like snapshot that is essentially multiple parallel time series each containing status of one patient. The next step for us is to apply algorithms like autoencoders and vision transformers to train an image reconstruction system...we haven't known if they will success yet! But the good thing is that we have literally infinite data, and heuristically I assume that's all one needs for DEEP learning...? We'll see.

