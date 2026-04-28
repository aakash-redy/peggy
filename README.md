🏎️ INDRA (Integrated Neural Design and Research Assistant)
An open-source, AI-powered rulebook search engine and RAG pipeline built for Formula Bharat and Formula Student teams.

[INSERT BADGES HERE - TECH STACK, LICENSE, VERSION]

📌 Why INDRA Exists
Designing a Formula Student car requires strict adherence to a 140+ page technical rulebook. Relying on Ctrl+F is inefficient, leading to missed cross-references, misinterpreted material specs, and frustrating tech inspection failures.

INDRA was built by Hexawatts Racing to solve this. It is a Retrieval-Augmented Generation (RAG) system that has ingested the official rulebook. Instead of scrolling through PDFs, your engineers can simply ask:
"What is the minimum wall thickness for the Front Hoop using 1020 steel?"

INDRA retrieves the exact rule (e.g., T 3.2), formats the material tables correctly, and gives you a direct, accurate answer.

🎯 Who is this for?
Technical Directors & Scrutineers: Instantly verify rules during design reviews.

Design Leads (Chassis, Powertrain, EV, Aero): Quickly check keep-out zones and material constraints without breaking CAD focus.

Team Software Leads: A production-ready template to build internal AI tools for your team.

🛠️ Tech Stack
Frontend: React + Vite

Backend: Node.js

Database: Supabase (PostgreSQL with pgvector for vector embeddings)

AI Engine: Google Gemini 1.5 (Extraction & Chat) + text-embedding-004

Ingestion Pipeline: Python 3 (pypdf, regex-based taxonomy tagging)

🚀 Quick Start & Installation
1. Clone the Repository
[INSERT GIT CLONE AND CD COMMANDS HERE]

2. Install Node Dependencies
[INSERT NPM INSTALL COMMAND HERE]

3. Environment Variables
Copy the example environment file and fill in your actual API keys.

[INSERT CP ENV EXAMPLE COMMAND HERE]

You will need:

A free Google AI Studio API Key

A free Supabase Project URL & Service Role Key

4. Database Setup (Supabase)
Navigate to your Supabase project's SQL Editor and run the following command to enable vector search and build the required table:

[INSERT SUPABASE SQL TABLE CREATION CODE HERE]

5. Ingest the Rulebook (Python)
INDRA needs to read and memorize the rulebook. Ensure you have Python installed, then run the ingestion engine.

[INSERT PYTHON VENV AND PIP INSTALL COMMANDS HERE]

Place your FB2027_Rules.pdf in the root directory and run the engine:

[INSERT PYTHON INGEST.PY COMMAND HERE]

(Note: The ingestion process takes about 1.5 to 2 hours to carefully read, classify, and upload all ~1,400 rules without hitting free-tier API rate limits. Grab a coffee.)

6. Run the App
Once the database is populated, start the development server:

[INSERT NPM RUN DEV COMMAND HERE]

🤝 Contributing
INDRA v1 is a massive leap forward for workflow automation, but it is not flawless. Sometimes a rule's cross-reference might get dropped, or a highly complex table might render oddly.

We made this open-source because we want the Formula Student community to use it, break it, and help enhance it. If your team builds a cool new feature (like CAD grading or automated quiz generation), please open a Pull Request!

Fork the Project

Create your Feature Branch

Commit your Changes

Push to the Branch

Open a Pull Request

📄 License
Distributed under the MIT License. See LICENSE for more information.
