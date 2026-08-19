"""Default seed data — ported verbatim from src/db/users.ts so a new user's
starting library and routine templates match the Node app exactly.
"""

DEFAULT_SEED_EXERCISES = [
    {"id": "ex_1", "name": "Barbell Bench Press", "category": "Chest", "equipment": "Barbell",
     "instructions": "Lie on bench, grip bar slightly wider than shoulder width. Lower bar smoothly to mid-chest and press up explosively."},
    {"id": "ex_2", "name": "Incline Dumbbell Press", "category": "Chest", "equipment": "Dumbbell",
     "instructions": "Set bench to 30-45 degree incline. Press dumbbells up over upper chest while maintaining core tension."},
    {"id": "ex_3", "name": "Barbell Back Squat", "category": "Legs", "equipment": "Barbell",
     "instructions": "Place bar across upper traps. Stand shoulder-width apart, brace core, sit hips down and back below parallel."},
    {"id": "ex_4", "name": "Romanian Deadlift", "category": "Legs", "equipment": "Barbell",
     "instructions": "Hinge at hips with slight knee bend, push glutes back until hamstring stretch, then drive hips forward."},
    {"id": "ex_5", "name": "Lat Pulldown", "category": "Back", "equipment": "Cable",
     "instructions": "Grip wide bar, pull down to upper chest while squeezing shoulder blades down and back."},
    {"id": "ex_6", "name": "Barbell Overhead Press", "category": "Shoulders", "equipment": "Barbell",
     "instructions": "Stand tall, rack bar on collarbone, press straight up overhead while locking out shoulders and glutes."},
    {"id": "ex_7", "name": "Dumbbell Bicep Curl", "category": "Arms", "equipment": "Dumbbell",
     "instructions": "Stand shoulder-width apart, curl weight up keeping elbows pinned to sides, squeeze peak contraction."},
    {"id": "ex_8", "name": "Tricep Rope Pushdown", "category": "Arms", "equipment": "Cable",
     "instructions": "Keep elbows fixed by torso, extend arms down and pull rope ends apart at bottom for full tricep lock."},
]

DEFAULT_TEMPLATES = [
    {"id": "tpl_1", "name": "Push Day (Chest, Shoulders, Triceps)",
     "description": "Classic heavy push session targeting chest, delts, and triceps.", "category": "Push",
     "exercises": [
         {"exerciseId": "ex_1", "defaultSets": 4, "defaultReps": 8},
         {"exerciseId": "ex_2", "defaultSets": 3, "defaultReps": 10},
         {"exerciseId": "ex_6", "defaultSets": 3, "defaultReps": 8},
         {"exerciseId": "ex_8", "defaultSets": 3, "defaultReps": 12},
     ]},
    {"id": "tpl_2", "name": "Pull Day (Back & Biceps)",
     "description": "Focus on vertical and horizontal pulls for back thickness and arms.", "category": "Pull",
     "exercises": [
         {"exerciseId": "ex_5", "defaultSets": 4, "defaultReps": 10},
         {"exerciseId": "ex_7", "defaultSets": 3, "defaultReps": 12},
     ]},
    {"id": "tpl_3", "name": "Leg Day (Quads & Hamstrings)",
     "description": "Heavy squatting and hamstring posterior chain work.", "category": "Legs",
     "exercises": [
         {"exerciseId": "ex_3", "defaultSets": 4, "defaultReps": 6},
         {"exerciseId": "ex_4", "defaultSets": 3, "defaultReps": 8},
     ]},
]

DEFAULT_MEMORIES = [
    "Fokus auf progressive Überlastung & saubere Technik",
    "Ziel: Muskelaufbau & Kraftsteigerung",
]
