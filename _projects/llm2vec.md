---
layout: page
title: EmbedLLM
description: Learning compact representation of large language models
img: assets/img/llm2vec.jpg
importance: 1
category: Finished
related_publications: false
---
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-R57GE0P1TR"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());

  gtag('config', 'G-R57GE0P1TR');
</script>

(Cover picture credit: [Medium](https://medium.com/@rebirth4vali/implementing-matrix-factorization-technique-for-recommender-systems-from-scratch-7828c9166d3c))

*TL;DR: We trained a system that turns LLMs into embeddings and show that this embedding contains rich information to **simultaneously** aid downstream tasks like correctness forecasting, model routing, and benchmark accuracy predictions!*

(Full paper link will be available soon!)

With hundreds of thousands of language models available on Huggingface today, efficiently evaluating and utilizing these models across various downstream tasks has become increasingly critical. Specifically, among all the models with various sizes, strengths, and weaknesses, how do we efficiently compare and utilize them?

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/llm2vec_1.jpg" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>

To address this question, we propose a novel framework, **EmbedLLM**, designed to create compact, reusable vector representations of LLMs. The core idea is simple: by embedding each model into a low-dimensional latent space, EmbedLLM captures essential features that can be reused across multiple downstream tasks, such as correctness prediction, model routing, and benchmark evaluation. Our approach significantly reduces the need for task-specific retraining, streamlining the process of working with multiple LLMs.

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/llm2vec_2.jpg" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>

One of the key innovations of EmbedLLM is its ability to map LLMs into a unified embedding space, making it easier to compare models and predict their performance on unseen tasks. This is achieved through a reconstruction-based system, where model correctness is predicted using a matrix factorization algorithm. Concretely, we try to learn a model embedding and a question embedding layer, such that we can simply use a linear classifier on the element-wise product of a model embedding and a question embedding to predict the binary label of whether that model can correctly answer that question.

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/llm2vec_3.jpg" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>

Our extensive experiments demonstrate that these embeddings not only capture key model characteristics but also perform well on multiple tasks. For example, the model router trained from the model embeddings outperform previous methods in both accuracy and speed, selecting the most appropriate model for a query with minimal computational overhead. Furthermore, probing experiments show that the embeddings reflect important traits of the models. Using the model embeddings to disclose properties of the benchmarks that are aligned with the ground truth nature of these benchmarks, we demonstrate that our methodology effectively help compresses useful information from the training data into the model embeddings.

<div class="row">
    <div class="col-sm mt-3 mt-md-0">
        {% include figure.liquid loading="eager" path="assets/img/llm2vec_4.jpg" title="example image" class="img-fluid rounded z-depth-1" %}
    </div>
</div>

PS: A short story about the project name: we originally named it "LLM2Vec" as aligning with the idea of Word2Vec but by the time our paper is done we found LLM2Vec already an [existing work](https://arxiv.org/abs/2404.05961). It is a great work but I still want to argue that our work fit the name a bit better :D
