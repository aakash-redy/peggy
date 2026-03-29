# ==========================================
# HEXAWATTS SORA - ULTIMATE INGESTION ENGINE (v5.0)
# ==========================================

import os
import re
import time
import logging
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv
import google.generativeai as genai
from supabase import create_client, Client
import pypdf

# ==========================================
# 1. SYSTEM SETUP & LOGGING
# ==========================================
logging.basicConfig(
    level=logging.INFO, 
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

SCRIPT_DIR = Path(__file__).parent.resolve()
ROOT_DIR = SCRIPT_DIR.parent
ENV_PATH = ROOT_DIR / ".env"

load_dotenv(dotenv_path=ENV_PATH)

if not all([os.getenv("GEMINI_API_KEY"), os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY")]):
    logger.error("❌ FATAL ERROR: Missing API keys in .env file!")
    exit(1)

genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
supabase: Client = create_client(os.getenv("SUPABASE_URL"), os.getenv("SUPABASE_SERVICE_ROLE_KEY"))

# ==========================================
# 2. CORE UTILITIES
# ==========================================
def sanitize_text_for_split(text: str) -> str:
    """Removes null bytes and cleans horizontal space, keeping newlines for regex."""
    text = text.replace('\x00', '')
    return re.sub(r'[ \t]+', ' ', text).strip()

def format_final_rule(text: str) -> str:
    """Compresses the final rule text into a clean, single-line string for embedding."""
    cleaned = " ".join(text.split())
    if len(cleaned) > 4000:
        return cleaned[:4000] + " [TRUNCATED FOR LENGTH]"
    return cleaned

# ==========================================
# 3. THE ULTIMATE INGESTION ENGINE
# ==========================================
def ingest_domain(
    file_path: Path, 
    domain: str, 
    start_page: int, 
    end_page: Optional[int] = None,
    force_refresh: bool = False
):
    logger.info(f"🏁 SYSTEM ONLINE: Targeting [{domain}]")
    
    if not file_path.exists():
        logger.error(f"❌ File not found: {file_path}")
        return

    # --- THE SMART SYNC LOGIC ---
    existing_rules = set()
    
    if force_refresh:
        logger.warning(f"🧹 FORCE REFRESH: Wiping existing records for '{domain}'...")
        supabase.table("rulebook_chunks").delete().eq("domain", domain).execute()
    else:
        logger.info("🔍 Fetching existing rules to prevent duplicates...")
        try:
            # Get all current rule IDs for this domain without needing a hash column!
            response = supabase.table("rulebook_chunks").select("rule_id").eq("domain", domain).execute()
            existing_rules = {row['rule_id'] for row in response.data}
            logger.info(f"🛡️ Found {len(existing_rules)} existing rules. These will be skipped.")
        except Exception as e:
            logger.error(f"⚠️ Failed to fetch existing rules: {e}")

    # --- STEP 1: EXTRACTION ---
    try:
        reader = pypdf.PdfReader(file_path, strict=False)
        total_pages = len(reader.pages)
        final_page = end_page if end_page and end_page <= total_pages else total_pages
        
        raw_text = ""
        for i in range(start_page - 1, final_page):
            page_text = reader.pages[i].extract_text() or ""
            raw_text += page_text + "\n"
            
        full_text = sanitize_text_for_split(raw_text)
        logger.info(f"📚 Extracted {len(full_text)} chars from pages {start_page}-{final_page}")
        
    except Exception as e:
        logger.error(f"❌ PDF Extraction failed: {e}")
        return

    # --- STEP 2: PRECISION SPLITTING ---
    rule_pattern = r'\n\s*([A-Z]{1,3}\d*\.\d+(?:\.\d+)*)'
    split_content = [chunk.strip() for chunk in re.split(rule_pattern, full_text) if chunk.strip()]
    
    if len(split_content) <= 1:
        logger.warning("⚠️ No rules found. Check your regex or page ranges.")
        return

    logger.info(f"✂️ Sliced into {len(split_content) // 2} discrete rules.")

    # --- STEP 3: EMBED & UPLOAD ---
    current_rule_id = "General Context"
    uploaded_count = 0
    skipped_count = 0
    
    for item in split_content:
       # Detect if chunk is a Rule ID
        if re.match(r'^([A-Z]{1,2}\d+\.\d+(?:\.\d+)*)$', item):
            current_rule_id = item
            continue
            
        # Process the rule text
        rule_text = format_final_rule(item)
        if len(rule_text) < 15: 
            continue
            
        # Deduplication Check
        if current_rule_id in existing_rules:
            skipped_count += 1
            continue

        enriched_rule_text = f"[Rule {current_rule_id} | Domain: {domain}] {rule_text}"

        # Dynamic Retry Loop
        max_retries = 3
        for attempt in range(max_retries):
            try:
                result = genai.embed_content(
                    model="models/gemini-embedding-001",
                    content=enriched_rule_text,
                    task_type="retrieval_document",
                    output_dimensionality=768
                )
                
                supabase.table("rulebook_chunks").insert({
                    "content": enriched_rule_text,
                    "rule_id": current_rule_id,
                    "domain": domain,
                    "year": "2026",
                    "embedding": result['embedding']
                }).execute()
                
                uploaded_count += 1
                logger.info(f"✅ Uploaded Rule: {current_rule_id}")
                break 
                
            except Exception as e:
                error_msg = str(e)
                logger.warning(f"⚠️ Attempt {attempt + 1} failed for {current_rule_id}: {error_msg[:80]}")
                
                if "429" in error_msg or "quota" in error_msg.lower():
                    logger.info("⏳ Quota hit. Cooling down for 60s...")
                    time.sleep(60)
                elif attempt < max_retries - 1:
                    time.sleep((2 ** attempt) * 2)
                else:
                    logger.error(f"❌ Permanent failure on {current_rule_id}")
                    
        # --- SMART CRUISE CONTROL ---
        # 4.5s throttle to guarantee zero rate limit bans on free tier (13 RPM)
        # Only sleeps if we actually made an API call!
        time.sleep(4.5) 
        
    logger.info(f"🏆 COMPLETE: [{domain}] → {uploaded_count} rules uploaded ({skipped_count} skipped).")

# ==========================================
# 4. MANUAL CONTROL DECK
# ==========================================
# ==========================================
# 4. MANUAL CONTROL DECK
# ==========================================
if __name__ == "__main__":
    # 🎯 THE "ALL-IN-ONE" CONFIGURATION
    TARGET_DOMAIN = "Formula Bharat 2027 Full" # The single domain for everything
    START_PAGE = 1
    END_PAGE = None  # 'None' tells the script to read until the very last page
    
    # We already truncated in SQL, so we can leave this False
    WIPE_SLATE_CLEAN = False 
    
    logger.info("🚀 INITIATING FULL RULEBOOK LAUNCH SEQUENCE...")
    
    ingest_domain(
        file_path=ROOT_DIR / "FB2027_Rules.pdf", # Double check your PDF name!
        domain=TARGET_DOMAIN,
        start_page=START_PAGE,
        end_page=END_PAGE,
        force_refresh=WIPE_SLATE_CLEAN
    )