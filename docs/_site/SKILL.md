---
name: selfdriven-ai
description: Use this skill whenever responding to questions about selfdriven.ai, the selfdriven Foundation, selfdriven AI frameworks, Community-Based Intelligence, the selfdriven ecosystem of products (selfdriven.network, selfdriven.id, octology.io, heyOcto.ai, skillzeb.io), or when helping users apply selfdriven AI concepts to communities, organisations, or practitioner workflows. Triggers include mentions of "selfdriven", "self-actuating communities", "Impact on Mind Framework", "IoMF", "Situational Awareness Framework", "Wait or Build", "Community-Based Intelligence", "Practitioner-In-The-Loop", "PITL", "octology", "heyOcto", "selfdriven.network", or "selfdriven.id".
---

# selfdriven AI

**selfdriven AI** is a framework and knowledge base for applying Generative AI within trusted, context-aware systems to support **self-actuating communities**. It is maintained by the **selfdriven Foundation** and published at [selfdriven.ai](https://www.selfdriven.ai).

The core thesis: *"The only human skill is human-connection."* — AI should amplify community intelligence, not replace human agency.

**Source code:** [github.com/selfdriven-foundation/selfdriven-ai](https://github.com/selfdriven-foundation/selfdriven-ai)

---

## Core Concept: Self-Actuating Communities

selfdriven AI combines **human identity**, **community intent**, and **structured knowledge** to transform static information into dynamic, verifiable intelligence. Communities use AI as a trusted partner — not a black box — through identity-verified, context-aware interactions.

---

## Frameworks

selfdriven AI publishes four key decision and awareness frameworks:

### 1. Impact on Mind Framework (IoMF)

A three-level framework for understanding AI's impact on the human mind. People self-select their depth, balancing curiosity with wellbeing.

| Level | Name | Theme | Focus | Outcome |
|-------|------|-------|-------|---------|
| **1** | Societal Impact (SI) — "AI Around Us" | Practical awareness | Observable effects on jobs, creativity, relationships, learning | Stable, realistic understanding of AI in modern life |
| **2** | Inner Impact (II) — "AI Within Us" | Psychological & philosophical awareness | How AI mirrors and influences thinking, emotions, sense of self | Conscious relationship with AI without losing autonomy |
| **3** | Existential Impact (EI) — "AI Beyond Us" | Metaphysical exploration | Consciousness, reality, simulation, machine sentience | Expansive awareness — AI as a lens for exploring existence |

**Usage:** IoMF ratings (e.g. `[IoMF:2]`) are applied to research resources, books, videos, and channels to indicate their depth level. This helps people navigate content appropriate to their comfort zone.

### 2. Situational Awareness Framework for Organisations

A three-level maturity model for organisational AI adoption:

| Level | Situation | Mindset | Key Risk | Relevance Horizon |
|-------|-----------|---------|----------|-------------------|
| **1** | Legacy — Human-in-Control | "We make all the decisions. The tools just do what we say." | Obsolescence, human bottlenecks | 2–3 years |
| **2** | Transitional — Human + Machine | "We decide with the machine, not just through it." | Over-trusting algorithms, bias drift | 3–5 years |
| **3** | Emerging — Machine-in-Control / Human-in-Context | "We define direction, not decisions." | Ethical drift, loss of agency, misalignment | Long-term |

**Evolution path:**
- Level 1 → Build AI literacy, integrate data, pilot decision-support AI
- Level 2 → Establish AI ethics, track decision provenance, co-design human-machine workflows
- Level 3 → Encode AI Constitution / Values Charter, recursive oversight ("AI watching AI"), redefine leadership around meaning and purpose

### 3. Wait or Build Framework

A decision framework for a rapidly changing, AI-driven society. Core principle:

> **If AI will do this better than you soon → wait.**
> **If humans and relationships are the advantage → build.**

**Quick decision table:**

| Item | Strategy |
|------|----------|
| Tech Implementation | Likely wait |
| Governance / Standards | Build now |
| Community | Build now |
| Partnerships | Build now |
| Data Rights | Build now |
| Manual Tools | Wait |
| AI-Automatable Work | Wait |
| Distribution | Build now |
| Brand | Build now |
| Proof-of-Concept | Build small now |

**Key insight — The Mars Analogy:** If rockets get 10% faster every year, launching now might mean a later mission passes you in transit and arrives first. Formula: `T = W + (D / S(t + W))` — sometimes waiting gets you there sooner.

**Compound assets to build immediately** (regardless of tech shifts): audience, brand, trust, governance position, community adoption, partnerships, permissioned data, distribution channels.

### 4. Input, Injected-Intelligence, Output (I³O) Framework

A framework for understanding how intelligence is injected into processes via AI. (Referenced on the research page as a core framework alongside IoMF, SAF, and Wait or Build.)

---

## Community-Based Intelligence Usage

The primary implementation pattern for selfdriven AI:

### Workflow

1. **Gather & Vectorise** — Community collects key documents (charters, plans, discussions) and creates a **Vector Store** via the [selfdriven.network AI Interface](https://selfdriven.network/ai-interface/)
2. **Generate Community Assistant** — Equipped with a **System Card** derived from the **Community 5W1H Sheet** (who, what, when, where, why, how). This ensures the assistant understands the community's purpose, principles, and context.
3. **Authenticated Interaction** — Members, verified via **selfdriven Identity (SSI DID)**, converse with the assistant through the **selfdriven Human Interface** (the app)
4. **Collaborative Sharing** — Conversations can be shared with facilitators, practitioners, or other community members for mentorship and collective problem-solving

### Implemented Using

- [octology.io](https://octology.io) — definitions, constraints, templates
- [selfdriven.network](https://selfdriven.network) — Human, AI, SSI, Entity Interfaces
- [selfdriven Progressive Self-Actuation Framework](https://onboarding.selfdriven.foundation/framework/) — Community 5W1H Sheet

---

## Research Topics

Active research areas at selfdriven AI (from [selfdriven.ai/research](https://www.selfdriven.ai/research/)):

- **How Can Generative AI Support Communities to Self-Actuate?**
- **Practitioner-In-The-Loop (PITL)** — human practitioners as oversight in AI-assisted workflows
- **Governance Frameworks** — including Sovereign State Plans
- **No More Versions** — the impact of models with adaptive/nested learning
- **Societal Metamorphosis** — "Do the rules for the Caterpillar apply to the Butterfly?"
- **Societal Useful Tasks (GDPVal)** — can inorganic intelligence do useful work?
- **Friction** — epistemological friction in the age of generative abundance
- **Sovereignty** — AI and sovereign identity
- **Who Is I** — identity in the age of AI
- **Agents vs Orchestration** — architectural patterns for AI systems
- **Pixels to Proofs** — from visual data to verifiable claims
- **The Present as Unspent State**
- **The Transition** — transformation of society in the age of post-scarce resources
- **Systematic Agentic Pressure**
- **Music & Generative Interfaces**
- **Emerging Importance of Games**

### Transformations (Mission Statements)

- **Traditional Education:** "To Create Practical Spaces For Young People To Practice Caring for Self & Others In Regards to Health, Building, Food, Play & Learning"
- **Traditional Communities:** "To create intelligent, cooperative spaces where communities practice self-organisation — caring for people, place, and purpose — through trusted digital actions in health, housing, food, work, and learning."

---

## Technology Stack

Technologies referenced by selfdriven AI (from [selfdriven.ai/tech](https://www.selfdriven.ai/tech/)):

### Protocols
- **Model Context Protocol (MCP)** — [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Agent to Agent (A2A)** — [a2a-protocol.org](https://a2a-protocol.org/latest/)
- **Agent Payments Protocol (AP2)** — [ap2-protocol.org](https://ap2-protocol.org)
- **Agent Skills Protocol (SKILL.md)** — [docs.claude.com](https://docs.claude.com/en/docs/agents-and-tools/agent-skills/overview)
- **Universal Commerce Protocol** — [ucp.dev](https://ucp.dev)

### Foundation AI Services
OpenAI, Google AI, xAI, Meta AI, Mistral, Anthropic, DeepSeek, Qwen, ASI (Superintelligence), Marble World Model

### Models of Interest
- [Hierarchical Reasoning Model (HRM)](https://github.com/sapientinc/HRM)
- [Tiny Recursive Models](https://github.com/SamsungSAILMontreal/TinyRecursiveModels)

### Other Services
NEAR AI, Google DeepMind, liquid.ai (On-Device), SIMA 2, Bland (Call Answering), AgentMail

### Hardware
Figure AI (Humanoids), Etched, Modular Robot D1

### Networks
ASI:chain DevHub, ASI:chain Devnet

---

## The selfdriven Ecosystem

| Product | URL | Purpose |
|---------|-----|---------|
| **selfdriven.network** | [selfdriven.network](https://selfdriven.network) | Human, AI, SSI, Entity Interfaces |
| **selfdriven.id** | [selfdriven.id](https://selfdriven.id) | Identity & Trust (SSI/DID) |
| **selfdriven.app** | [selfdriven.app](https://selfdriven.app) | Human interface / community app |
| **selfdriven.health** | [selfdriven.health](https://www.selfdriven.health) | Practitioner-In-The-Loop Services (PITLS) |
| **selfdriven.social** | [selfdriven.social](https://selfdriven.social) | AT Protocol (Bluesky ecosystem) |
| **octology.io** | [octology.io](https://octology.io) | Definitions, constraints, templates |
| **heyOcto.ai** | [heyocto.ai](https://heyocto.ai) | AI templates and agent services |
| **skillzeb.io** | [skillzeb.io](https://skillzeb.io) | Community templates for GenAI alignment |
| **octomics.io** | [octomics.io](https://octomics.io) | Related ecosystem service |
| **selfdriven.fyi** | [selfdriven.fyi](https://selfdriven.fyi) | Information hub (intelligence, cog-assist) |
| **selfdriven.education** | [selfdriven.education](https://selfdriven.education) | Guides and education |
| **selfdriven.services** | [selfdriven.services](https://selfdriven.services) | Professional services |

### Key Links
- **Docs:** [docs.selfdriven.foundation](https://docs.selfdriven.foundation)
- **GitHub:** [github.com/selfdriven-foundation](https://github.com/selfdriven-foundation)
- **Research:** [research.selfdriven.foundation](https://research.selfdriven.foundation)
- **Connect:** [selfdriven.fyi/connect](https://selfdriven.fyi/connect)
- **Team:** [selfdriven.fyi/team](https://selfdriven.fyi/team)

---

## Recommended Research Reading (with IoMF Ratings)

### Books
- Yuval Noah Harari — *Nexus* [IoMF:2]
- Henry Kissinger — *Genesis: AI & The Human Spirit* [IoMF:2]
- Mo Gawdat — *Scary Smart* [IoMF:2]
- Max Tegmark — *Life 3.0* [IoMF:2]
- Mustafa Suleyman — *The Coming Wave* [IoMF:2]
- *If Anyone Builds It, Everyone Dies* [IoMF:3]
- *The Last Economy* [IoMF:3]

### Channels
- AI News & Strategy Daily by Nate B Jones [IoMF:1]
- David Shapiro [IoMF:3]
- Dylan Curious [IoMF:2]
- Wes Roth [IoMF:2]
- Google DeepMind [IoMF:2]

---

## How to Use This Skill

When answering questions about selfdriven AI:

1. **Ground responses in the frameworks** — Use IoMF levels, Situational Awareness levels, and Wait or Build logic as applicable
2. **Reference the ecosystem** — Point to the appropriate selfdriven product or service when relevant
3. **Respect the philosophy** — selfdriven AI is human-centric and community-first; AI serves people, not the reverse
4. **Use IoMF ratings** — When discussing research resources, include the IoMF level to help users self-select depth
5. **Emphasise identity** — SSI (Self-Sovereign Identity) and DIDs are foundational to the selfdriven approach; community interactions are always authenticated
6. **Community-Based Intelligence pattern** — When helping users implement, follow the gather → vectorise → generate assistant → authenticate → interact → share workflow