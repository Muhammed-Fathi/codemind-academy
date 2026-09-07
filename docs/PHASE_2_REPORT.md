# Phase 2 Report — Curriculum Source Analysis & Knowledge Model

> **Status: COMPLETE — awaiting explicit approval to begin Phase 3.**
>
> **Phase gate:** This phase only inspected the four committed curriculum PDFs, produced the source-aligned knowledge model, and added reproducible validation. No Question Bank, Quiz, Exam, PDF-generation, Kodgy runtime, UI, API, or database-seeding feature was implemented.

## 1. Phase objective and acceptance status

Phase 2 establishes one traceable curriculum/knowledge contract for the later Question Bank, Session Quizzes, Unit Exams, Mock Exams, generated PDFs, and Kodgy. Every lesson objective and concept anchor in the model retains an English PDF page, Arabic PDF page, stable lesson ID, and Part/Unit scope.

| Acceptance item | Status | Evidence |
| --- | --- | --- |
| Inspect all four committed curriculum PDFs | PASS | Four source files are listed and hashed in `docs/curriculum/knowledge-model.json`. |
| Extract official hierarchy and lesson inventory | PASS | 2 Parts → 7 Units → 23 Lessons; see Section 4. |
| Capture bilingual source identity and page provenance | PASS | English/Arabic title fields and PDF/textbook page ranges are stored per lesson. |
| Capture objectives and knowledge anchors | PASS | 46 objectives and 129 unique concepts / 134 lesson occurrences are represented. |
| Validate model against actual PDF content | PASS | `scripts/validate-curriculum-knowledge.py` passed against all four PDFs. |
| Keep downstream phases gated | PASS | Assessment/Kodgy entries are data contracts only; no downstream behavior was added. |

## 2. Source inventory

The committed PDFs are treated as the authoritative source set. English is the canonical normalized structure locale; Arabic is the required localization and cross-check source. PDF page numbers below are physical PDF pages, not printed textbook page numbers.

| Source ID | Locale | Part | File | PDF pages | Contents page | SHA-256 |
| --- | --- | --- | --- | ---: | ---: | --- |
| `source-en-p1` | `en` | `P1` | `docs/curriculum/english/Programming-ArtificialIntelligence-En-EB-part 1.pdf` | 104 | 4 | `068e2bf706c7d92fd2483fbbca5d2457a9a430e8a1226fa38908f3fd6990a9b1` |
| `source-en-p2` | `en` | `P2` | `docs/curriculum/english/Programming-ArtificialIntelligence-En-EB-part 2.pdf` | 88 | 4 | `f61204beb3d25db0d7696558a04e354cef7dcb39d2ead82fff08b6bce2a9192a` |
| `source-ar-p1` | `ar` | `P1` | `docs/curriculum/arabic/Programming-ArtificialIntelligence-Ar-EB-part 1.pdf` | 95 | 4 | `11675fe5a1ddad6e0da8451dc8412cae02121008ce9dadc918fed5e1a41e352d` |
| `source-ar-p2` | `ar` | `P2` | `docs/curriculum/arabic/Programming-ArtificialIntelligence-Ar-EB-part 2.pdf` | 77 | 4 | `fbad37d73a458e4099ee70eebfd8225ffc09becc4bfd2ea83a2de825d43dc089` |

### Source handling notes

- The English Part 1 contents page covers Units 1–4 and the English Part 2 contents page covers Units 5–7. The English files also contain answer/glossary/editorial pages after the lesson content; these are retained in the source page counts but are not promoted to lessons.
- The Arabic files have different physical page counts and more compact printed-page ranges. The model stores both locale-specific physical PDF ranges and textbook-page ranges instead of assuming that English and Arabic page numbers align.
- The Arabic PDFs contain RTL text-layer ordering artifacts when extracted with `pypdf`. The Arabic validation therefore checks the recorded page ranges and the Arabic objective/Key Concepts block markers; Arabic display labels are transcribed in the model from the bilingual contents and lesson headings.
- The model distinguishes **verbatim/source-derived fields** (titles, objectives, key-concept labels, pages) from **curated derivatives** (short summaries, cautions, stable concept IDs, and prerequisite edges).

## 3. Extraction and validation method

1. Read the contents page in each language/part to establish the official unit and lesson boundaries.
2. Read every lesson start page to capture the `Learning Objectives` block and every lesson knowledge-anchor page to capture `Key Concepts` (or the explicit term-definition block for Lesson 1-2, which has no labelled Key Concepts box in the extracted English layer).
3. Recorded both physical PDF ranges and printed textbook ranges. Page ranges are inclusive and locale-specific.
4. Normalized the model to stable IDs: `part-1`, `unit-1`, and `lesson-1-1` through `lesson-7-3`; source labels remain available as human-readable fields.
5. Validated hashes, page counts, contents markers, lesson headings, objective text, concept evidence, Arabic block markers, counts, and dependency references.

Re-run from the repository root (the validator intentionally uses an external PDF parser and does not add a runtime dependency):

```bash
python3 -m pip install pypdf  # outside the application dependency graph, if needed
python3 scripts/validate-curriculum-knowledge.py
```

Observed result on 2026-09-07:

```text
PASS: Phase 2 curriculum knowledge model is source-aligned.
sources: 4 PDFs; pages: source-en-p1=104, source-en-p2=88, source-ar-p1=95, source-ar-p2=77
hierarchy: 2 parts / 7 units / 23 lessons
objectives: 46; concepts: 129 unique / 134 lesson occurrences
validation: hashes, page counts, English contents/headings/objectives/concepts, Arabic block/page evidence, IDs and relations
```

## 4. Validated official curriculum structure

| Part | Unit | Unit title | Lessons | Printed textbook span (EN / AR) |
| --- | ---: | --- | ---: | --- |
| P1 — Part 1 | 1 | **Information Technology and Society**<br>تكنولوجيا المعلومات والمجتمع | 4 | 4–32 / 4–30 |
| P1 — Part 1 | 2 | **Cybersecurity**<br>الأمن السيبراني | 3 | 33–54 / 31–49 |
| P1 — Part 1 | 3 | **Web Applications**<br>تطبيقات الويب | 3 | 55–74 / 50–67 |
| P1 — Part 1 | 4 | **Web and Media Design**<br>تصميم الويب والوسائط | 4 | 75–101 / 68–91 |
| P2 — Part 2 | 5 | **Data Collection and Cleaning**<br>جمع البيانات وتنقيتها | 3 | 4–28 / 4–25 |
| P2 — Part 2 | 6 | **Analysis and Communication**<br>التحليل والتواصل | 3 | 29–56 / 26–49 |
| P2 — Part 2 | 7 | **Machine Learning and Artificial Intelligence**<br>التعلم الآلي والذكاء الاصطناعي | 3 | 57–85 / 50–72 |

### Structural conclusion

- The official PDFs expose **Part → Unit → Lesson**. They do not expose the application’s existing `Topic` layer as a curricular level.
- Any later database mapping that needs `Topic` must explicitly mark it as a presentation/compatibility wrapper; it must not invent curricular topics or silently change assessment scope.
- There are 14 lessons in Part 1 and 9 lessons in Part 2. Every lesson has two learning objectives in the inspected source set.

## 5. Complete lesson and knowledge-anchor inventory

The table is the human-readable index. The machine-readable record, including full bilingual objective text, stable concept IDs, summaries, cautions, and exact page arrays, is in `docs/curriculum/knowledge-model.json`.

### P1 — Part 1 / الجزء الأول

#### Unit 1 — Information Technology and Society / تكنولوجيا المعلومات والمجتمع

| Code | Lesson | English PDF pages | Arabic PDF pages | Objectives | Source knowledge anchors |
| --- | --- | ---: | ---: | ---: | --- |
| `1-1` | **Development of Information Technology and Social Transformation**<br>تطور تكنولوجيا المعلومات والتحول الاجتماعي | 5–12 | 5–12 | 2 | Moore's Law; SNS; e-commerce; remote work; online learning; cashless payment; edge computing; autonomous driving; AR / VR; quantum computing |
| `1-2` | **How AI Works**<br>كيف يعمل الذكاء الاصطناعي | 13–19 | 13–18 | 2 | AI (Artificial Intelligence); machine learning; deep learning; neural network; generative AI |
| `1-3` | **AI in Daily Life and Industry**<br>الذكاء الاصطناعي في الحياة اليومية والصناعة | 20–26 | 19–24 | 2 | recommendation system; voice assistant; machine translation; face recognition; image-diagnosis AI; predictive maintenance; black-box problem; hallucination |
| `1-4` | **Ethical Issues with AI**<br>القضايا الأخلاقية للذكاء الاصطناعي | 27–33 | 25–31 | 2 | algorithmic bias; training data; face recognition; privacy; explainable AI (XAI); black-box problem; responsibility; fairness; transparency; privacy protection; accountability |

- **1-1 objectives** — Explain the major stages in the development of information technology and their impact on society. / Give examples of social changes and emerging technologies brought about by information technology, and explain their characteristics.
- **1-2 objectives** — Explain what AI is. / Explain how generative AI is positioned within AI technologies.
- **1-3 objectives** — Give examples of how AI is used in daily life and various industries. / Explain what AI is good at and what requires caution when using AI.
- **1-4 objectives** — Explain what algorithmic bias is and describe its main causes. / Connect the basic principles of AI ethics (fairness, transparency, privacy protection, and accountability) to specific situations.

#### Unit 2 — Cybersecurity / الأمن السيبراني

| Code | Lesson | English PDF pages | Arabic PDF pages | Objectives | Source knowledge anchors |
| --- | --- | ---: | ---: | ---: | --- |
| `2-1` | **Cryptographic Technologies and Authentication**<br>تقنيات التشفير والمصادقة | 34–41 | 32–38 | 2 | HTTPS; common-key cryptography; public-key cryptography; TLS handshake; multi-factor authentication; digital signature; digital certificate; non-repudiation |
| `2-2` | **Network Security Design**<br>تصميم أمن الشبكات | 42–48 | 39–44 | 2 | firewall; VPN; DMZ; defense in depth; zero trust; perimeter |
| `2-3` | **Incident Response and Risk Management**<br>الاستجابة للحوادث وإدارة المخاطر | 49–55 | 45–50 | 2 | security incident; the six stages; containment / eradication; risk = impact × likelihood |

- **2-1 objectives** — Explain how HTTPS secures communication: how the TLS handshake uses public-key cryptography to share a key safely, and how common-key cryptography then protects the data that follows. / Describe how authentication, including multi-factor authentication, is used in real services, and explain why security technologies are combined.
- **2-2 objectives** — Explain the roles of firewalls, VPNs, and DMZs in protecting a network. / Describe defense in depth and zero trust, and explain why layered, verified access is stronger than a single barrier.
- **2-3 objectives** — Explain what a security incident is and describe the stages of incident response in the correct order. / Apply the idea of risk assessment by prioritizing risks according to their impact and likelihood.

#### Unit 3 — Web Applications / تطبيقات الويب

| Code | Lesson | English PDF pages | Arabic PDF pages | Objectives | Source knowledge anchors |
| --- | --- | ---: | ---: | ---: | --- |
| `3-1` | **The Overall Structure of Web Applications**<br>البنية العامة لتطبيقات الويب | 56–62 | 51–56 | 2 | web application; frontend; backend; database; three-tier architecture |
| `3-2` | **Web Application Communication Methods**<br>طرق الاتصال في تطبيقات الويب | 63–68 | 57–62 | 2 | client / server; HTTP / HTTPS; HTTP method; status code; API / JSON |
| `3-3` | **Fundamentals of Frontend Technology**<br>أساسيات تكنولوجيا الواجهة الأمامية | 69–75 | 63–68 | 2 | HTML / CSS / JavaScript; semantic HTML; accessibility / SEO; responsive design; framework |

- **3-1 objectives** — Explain what a web application is and describe the roles of its three tiers: frontend, backend, and database. / Trace how the three tiers cooperate to turn a user’s action into a result, using familiar services as examples.
- **3-2 objectives** — Explain the client and server model and the difference between HTTP and HTTPS. / Describe how HTTP requests and responses work, and explain the role of an API in exchanging data.
- **3-3 objectives** — Explain the distinct roles of HTML, CSS, and JavaScript in building a web page. / Describe how semantic HTML, responsive design, and frameworks improve a modern frontend.

#### Unit 4 — Web and Media Design / تصميم الويب والوسائط

| Code | Lesson | English PDF pages | Arabic PDF pages | Objectives | Source knowledge anchors |
| --- | --- | ---: | ---: | ---: | --- |
| `4-1` | **Types and Characteristics of Media**<br>أنواع الوسائط وخصائصها | 76–81 | 69–74 | 2 | TV / radio / newspaper; website / SNS; one-way / two-way; strengths / constraints; combining media |
| `4-2` | **Information Design and User Experience for Websites**<br>تصميم المعلومات وتجربة المستخدم للمواقع | 82–88 | 75–81 | 2 | persona; wireframe; contrast / repetition; alignment / proximity; user-centered design |
| `4-3` | **Methods for Evaluating Websites**<br>أساليب تقييم المواقع الإلكترونية | 89–95 | 82–87 | 2 | qualitative evaluation; quantitative evaluation; web analytics; PV / bounce rate / CVR; heuristic evaluation |
| `4-4` | **The Iterative Improvement Process for Websites**<br>عملية التحسين التكراري للمواقع | 96–102 | 88–93 | 2 | PDCA cycle; Plan / Do / Check / Act; design thinking; A/B testing; continuous improvement |

- **4-1 objectives** — Compare the characteristics of different media, and explain the strengths and constraints of websites. / Choose suitable media for a given purpose and audience, and justify the choice.
- **4-2 objectives** — Explain how personas and wireframes are used to plan a website before designing its appearance. / Apply the four principles of design (contrast, repetition, alignment, proximity) and explain the idea of user-centered design.
- **4-3 objectives** — Distinguish qualitative from quantitative evaluation, and explain the major indicators used in web analytics. / Explain how heuristic evaluation works, and why combining both approaches gives a clearer picture of a website.
- **4-4 objectives** — Explain the PDCA cycle and the steps of design thinking as ways of improving a website. / Describe how A/B testing compares two options using real data, and explain why improvement is repeated in cycles.

### P2 — Part 2 / الجزء الثاني

#### Unit 5 — Data Collection and Cleaning / جمع البيانات وتنقيتها

| Code | Lesson | English PDF pages | Arabic PDF pages | Objectives | Source knowledge anchors |
| --- | --- | ---: | ---: | ---: | --- |
| `5-1` | **Methods of Data Collection**<br>طرق جمع البيانات | 5–12 | 5–11 | 2 | data collection; primary / secondary data; population & sample; sampling (simple random, stratified); sampling bias |
| `5-2` | **Data Cleaning and Transformation**<br>تنقية البيانات وتحويلها | 13–21 | 12–19 | 2 | data cleaning / transformation; missing values, outliers, duplicates; data type conversion; normalization / standardization; reshaping (pivot, join, aggregation) |
| `5-3` | **Open Data and APIs**<br>البيانات المفتوحة وواجهات برمجة التطبيقات | 22–29 | 20–26 | 2 | open data; World Bank Open Data / UN Data / Kaggle; API / endpoint / JSON; terms of use; source citation |

- **5-1 objectives** — Distinguish primary from secondary data and explain when each is appropriate. / Explain how sampling works, and describe how sampling bias can lead to confident but wrong conclusions.
- **5-2 objectives** — Explain how missing values, outliers, and duplicate data are handled when cleaning a dataset. / Describe data type conversion, normalization and standardization, and the reshaping of data to fit a purpose.
- **5-3 objectives** — Explain what open data is and identify major reliable sources of it. / Describe how data is obtained through an API, and explain the importance of terms of use and source citation.

#### Unit 6 — Analysis and Communication / التحليل والتواصل

| Code | Lesson | English PDF pages | Arabic PDF pages | Objectives | Source knowledge anchors |
| --- | --- | ---: | ---: | ---: | --- |
| `6-1` | **Statistical Inference**<br>الاستدلال الإحصائي | 30–39 | 27–34 | 2 | statistical inference; point / interval estimation; confidence interval & level; null / alternative hypothesis; p-value & significance level; Type I / II errors |
| `6-2` | **Use and Evaluation of Regression Analysis**<br>استخدام تحليل الانحدار وتقييمه | 40–48 | 35–42 | 2 | regression analysis; response / explanatory variable; simple / multiple regression; regression line, least-squares; R², RMSE, MAE; correlation versus causation |
| `6-3` | **Data Visualization and Communication**<br>تصور البيانات والتواصل | 49–57 | 43–50 | 2 | data visualization; heatmap; mosaic plot; overplotting; data storytelling |

- **6-1 objectives** — Explain the difference between point estimation and interval estimation, including the meaning of a confidence level. / Describe the procedure of hypothesis testing, and explain the cautions needed when interpreting its results.
- **6-2 objectives** — Explain the difference between simple and multiple regression, and what a regression model represents. / Evaluate a regression model using R², RMSE, and MAE, and explain why a good fit does not prove causation.
- **6-3 objectives** — Explain the role of data visualization and select suitable graphs, including for multiple variables. / Apply data storytelling to communicate a clear and honest message from data.

#### Unit 7 — Machine Learning and Artificial Intelligence / التعلم الآلي والذكاء الاصطناعي

| Code | Lesson | English PDF pages | Arabic PDF pages | Objectives | Source knowledge anchors |
| --- | --- | ---: | ---: | ---: | --- |
| `7-1` | **The Basics of Machine Learning**<br>أساسيات التعلم الآلي | 58–68 | 51–59 | 2 | machine learning; supervised / unsupervised / reinforcement; classification, feature; clustering; bias, black-box problem |
| `7-2` | **Neural Networks and Deep Learning**<br>الشبكات العصبية والتعلم العميق | 69–77 | 60–67 | 2 | node (neuron), layer; input / hidden / output layer; weight, training; deep learning; hierarchical features |
| `7-3` | **Large Language Models (LLM) and Generative AI**<br>نماذج اللغة الكبيرة (LLM) والذكاء الاصطناعي التوليدي | 78–86 | 68–75 | 2 | language model, next-word prediction; hallucination; large language model (LLM), parameters; RLHF; multimodality |

- **7-1 objectives** — Explain the idea of machine learning and distinguish supervised, unsupervised, and reinforcement learning. / Describe classification, clustering, and reinforcement learning with examples, and explain the limits caused by data bias and the black-box problem.
- **7-2 objectives** — Describe the structure of a neural network and explain how a single neuron processes its inputs. / Explain what deep learning is, and why stacking many hidden layers brought a leap in AI performance.
- **7-3 objectives** — Explain how a language model generates text by predicting the next word, and why this causes hallucination. / Describe what makes a language model large, and explain the roles of RLHF tuning and multimodality.

### Knowledge-anchor coverage

- Each lesson stores the concepts exactly as source labels where possible, including formulas/abbreviations such as `risk = impact × likelihood`, `PV / bounce rate / CVR`, `R², RMSE, MAE`, and `RLHF`.
- Repeated terms such as `face recognition`, `black-box problem`, `hallucination`, `API`, and AI/ML terms are de-duplicated into stable global concept IDs while retaining every lesson/page occurrence.
- Lesson-level cautions preserve high-value distinctions in the source, for example: correlation is not causation; statistical significance is not practical importance; HTTPS is not HTTP; and RLHF does not guarantee truth.

## 6. Knowledge model contract

### 6.1 Core entities

| Entity | Purpose | Required provenance |
| --- | --- | --- |
| Source | One committed PDF, locale, Part, hash, and page count | Path, SHA-256, PDF page count |
| Part | Official term/semester grouping | English + Arabic source IDs |
| Unit | Official thematic grouping | Locale-specific printed-page span |
| Lesson | Smallest official teaching/assessment scope | Stable ID, code, bilingual title, PDF/textbook pages |
| Objective | Intended learning outcome | English/Arabic text, verb, cognitive level, objective page |
| Concept | Reusable knowledge anchor | Canonical label, Arabic label, first introduction, all lesson/page evidence |
| Knowledge relation | Explicit or inferred learning dependency | From/to lesson IDs, basis, rationale |
| Assessment contract | Scope rules for later phases | Lesson/unit/part/mock boundaries; no item generation here |
| Kodgy grounding contract | Retrieval and answer-safety keys for later phases | Part/unit/lesson/concept/locale/page keys; no chat runtime here |

### 6.2 Assessment-ready boundaries

- **Lesson scope:** only the lesson’s objectives and source-backed concepts.
- **Unit scope:** all lessons in the same official Unit, preserving each lesson ID as item provenance.
- **Part scope:** all Units in one Part; no silent cross-Part mixing.
- **Mock scope:** the complete two-Part curriculum; every later item must still carry Part/Unit/Lesson provenance.
- Difficulty, question wording, answer keys, quiz sessions, exam assembly, PDF rendering, and grading are intentionally not part of Phase 2 implementation.

### 6.3 Knowledge relations

The model records 18 relation edges. The within-unit sequence edges are **inferences from official ordering and objectives**, not claims that the textbook explicitly labels formal prerequisites. One cross-Part continuity edge connects the Part 1 AI/ML introduction to Unit 7. Later phases may use these edges for sequencing, but must preserve their inferred status.

## 7. Findings that affect later implementation

### Finding A — Existing application seed is not source-aligned

The pre-existing `src/lib/curriculum.ts` is a synthetic application seed: it inserts an extra Topic layer, uses invented lesson names such as “What is IT?” and “Web Scraping Basics,” assigns fixed 90-minute durations, and contains 36 lesson entries rather than the 23 lessons in the committed PDFs. It must not be treated as the official source model.

This Phase 2 work does **not** replace that seed or change database behavior, because doing so would cross the requested phase boundary into integration/downstream implementation. The source-aligned JSON is the approved foundation to use in a later implementation phase; the mismatch is recorded here so it cannot be missed.

### Finding B — No source-defined duration or Topic layer

The inspected PDFs define objectives, concepts, explanations, activities, and exercises, but do not provide the application’s fixed lesson-duration field or a separate Topic hierarchy. Later scheduling and Topic compatibility behavior must be product metadata, not source curriculum claims.

### Finding C — Bilingual page alignment is not positional

English and Arabic files are parallel official materials, not page-for-page copies. A future generated PDF or Kodgy citation must cite the selected locale’s page range; it must not reuse an English page number for an Arabic answer.

### Finding D — High-value cross-cutting knowledge threads

- Responsible technology: social impact → AI limitations → AI ethics → cybersecurity/privacy.
- Web systems: three-tier architecture → HTTP/API communication → frontend technology → UX/evaluation/iteration.
- Data lifecycle: collection/sampling → cleaning/transformation → open data/API use → inference → regression → visualization/communication.
- AI progression: AI → machine learning → deep learning → neural networks/LLMs/generative AI, with bias, black-box, hallucination, and verification cautions carried throughout.

## 8. Phase 2 deliverables

| File | Role |
| --- | --- |
| `docs/curriculum/knowledge-model.json` | Complete source-aligned bilingual knowledge model and provenance data. |
| `docs/curriculum/knowledge-model.schema.json` | JSON Schema contract for the model envelope and core entities. |
| `scripts/validate-curriculum-knowledge.py` | Reproducible PDF/hash/page/content/model validation; no application side effects. |
| `docs/PHASE_2_REPORT.md` | This complete Phase 2 report and approval-gate record. |

## 9. Explicitly deferred to later phases

The following were intentionally not implemented:

- replacing or seeding the application database from the new model;
- creating Question Bank records or item authoring workflows;
- Session Quizzes, Unit Exams, Mock Exams, grading, randomization, or exam blueprints beyond the data contract;
- generated student/teacher PDF documents;
- Kodgy retrieval, chat behavior, UI, prompts, or source citation runtime;
- changes to existing curriculum APIs, portals, UI, Prisma schema, or tests.

## 10. Approval gate

Phase 2 is complete and stopped here. I will wait for explicit approval before beginning Phase 3. No downstream feature work will be started implicitly.

