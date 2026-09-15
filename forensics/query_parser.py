import re
from typing import Optional, Dict, Any, List
from forensics.schemas import TrafficQueryAST, AmbiguityClarification, AmbiguityOption

COLOR_MAP = {
    "red": "Red", "crimson": "Red", "maroon": "Red", "ruby": "Red",
    "white": "White", "ivory": "White", "pearl": "White",
    "black": "Black", "dark": "Black", "midnight": "Black",
    "silver": "Silver", "gray": "Silver", "grey": "Silver", "metallic": "Silver",
    "blue": "Blue", "navy": "Blue", "cyan": "Blue", "azure": "Blue",
    "yellow": "Yellow", "gold": "Yellow", "golden": "Yellow",
    "green": "Green", "emerald": "Green", "olive": "Green",
    "orange": "Orange", "amber": "Orange",
    "brown": "Brown", "bronze": "Brown", "chocolate": "Brown"
}

CLASS_MAP = {
    "car": "car", "cars": "car", "sedan": "car", "suv": "car", "hatchback": "car",
    "motorcycle": "motorcycle", "motorcycles": "motorcycle", "bike": "motorcycle",
    "bikes": "motorcycle", "scooter": "motorcycle", "scooters": "motorcycle",
    "two-wheeler": "motorcycle", "two-wheelers": "motorcycle", "twowheeler": "motorcycle",
    "truck": "truck", "trucks": "truck", "lorry": "truck",
    "bus": "bus", "buses": "bus",
    "autorickshaw": "autorickshaw", "auto": "autorickshaw", "rickshaw": "autorickshaw",
    "van": "van", "vans": "van",
    "vehicle": "vehicle", "vehicles": "vehicle"
}

INDIAN_STATES = {
    "MH": "Maharashtra", "DL": "Delhi", "KA": "Karnataka", "GJ": "Gujarat",
    "TN": "Tamil Nadu", "UP": "Uttar Pradesh", "HR": "Haryana", "PB": "Punjab",
    "RJ": "Rajasthan", "KL": "Kerala", "TS": "Telangana", "AP": "Andhra Pradesh",
    "WB": "West Bengal", "MP": "Madhya Pradesh", "BR": "Bihar", "GA": "Goa"
}

def parse_server_query(raw_query: str) -> TrafficQueryAST:
    norm = raw_query.lower()
    norm = re.sub(r"['’]", "", norm)
    norm = re.sub(r"[^\w\s-><=/]", " ", norm)
    norm = re.sub(r"\s+", " ", norm).strip()

    # Intent
    intent = "search"
    if re.search(r"\b(how many|count|total)\b", norm):
        intent = "count"
    elif re.search(r"\b(where is|where was|last seen)\b", norm):
        intent = "last_seen"
    elif re.search(r"\b(movement history|route|trajectory|history)\b", norm):
        intent = "movement_history"
    elif re.search(r"\b(fastest|top speed)\b", norm):
        intent = "fastest"

    # Colors
    colors: List[str] = []
    for kw, col in COLOR_MAP.items():
        if re.search(rf"\b{kw}\b", norm) and col not in colors:
            colors.append(col)

    # Classes
    classes: List[str] = []
    for kw, cls in CLASS_MAP.items():
        if re.search(rf"\b{kw}\b", norm) and cls not in classes:
            classes.append(cls)

    # Speed
    speed_cond: Optional[Dict[str, Any]] = None
    if re.search(r"\b(fastest|highest speed|top speed)\b", norm):
        speed_cond = {"operator": "fastest"}
    else:
        between_m = re.search(r"\b(?:between|from)\s+(\d+)\s*(?:and|to|-)\s*(\d+)", norm)
        if between_m:
            v1, v2 = int(between_m.group(1)), int(between_m.group(2))
            speed_cond = {"operator": "between", "value": min(v1, v2), "upperValue": max(v1, v2)}
        else:
            above_m = re.search(r"(?:above|over|exceeding|faster than|>)\s*(\d+)", norm)
            if above_m:
                speed_cond = {"operator": ">", "value": int(above_m.group(1))}
            else:
                below_m = re.search(r"(?:below|under|slower than|<)\s*(\d+)", norm)
                if below_m:
                    speed_cond = {"operator": "<", "value": int(below_m.group(1))}
                elif re.search(r"\b(speeding|overspeeding|speed violation)\b", norm):
                    speed_cond = {"operator": "speeding", "value": 50}

    # Plate
    plate_cond: Optional[Dict[str, Any]] = None
    exact_m = re.search(r"\b([A-Za-z]{2}\s*[-]?\s*[0-9]{1,2}\s*[-]?\s*[A-Za-z]{0,3}\s*[-]?\s*[0-9]{4})\b", raw_query)
    if exact_m:
        clean_plate = re.sub(r"[^A-Za-z0-9]", "", exact_m.group(1)).upper()
        plate_cond = {"mode": "exact", "text": clean_plate, "stateCode": clean_plate[:2]}
    elif re.search(r"\b(without plate|no plate|unscanned)\b", norm):
        plate_cond = {"mode": "unscanned"}
    else:
        for code, state_name in INDIAN_STATES.items():
            if re.search(rf"\b{code}\b", raw_query) or re.search(rf"\b{state_name.lower()}\b", norm):
                plate_cond = {"mode": "state", "stateCode": code}
                break

        if not plate_cond and re.search(r"\b(with plate|with number plate|scanned plate|number plate)\b", norm):
            plate_cond = {"mode": "has_plate"}

    # Violations
    violations: List[str] = []
    if re.search(r"\b(helmet|no helmet)\b", norm):
        violations.append("helmet")
    if re.search(r"\b(triple|triple riding)\b", norm):
        violations.append("triple_riding")
    if re.search(r"\b(overspeeding|speed limit)\b", norm):
        violations.append("overspeeding")
    if re.search(r"\b(wrong way)\b", norm):
        violations.append("wrong_way")
    if re.search(r"\b(violation|challan)\b", norm) and not violations:
        violations.append("any")

    # Ambiguity
    ambiguity: Optional[AmbiguityClarification] = None
    if re.search(r"\b(dangerous|reckless|unsafe)\b", norm):
        ambiguity = AmbiguityClarification(
            isAmbiguous=True,
            reason="Query specifies 'dangerous' vehicles. Filter by speed or violation type?",
            options=[
                AmbiguityOption(label="⚡ Speeding over 60 km/h", query="Vehicles speeding above 60 km/h"),
                AmbiguityOption(label="🪖 No Helmet Violations", query="Two-wheelers without helmet"),
                AmbiguityOption(label="👥 Triple Riding", query="Two-wheelers with triple riding"),
            ]
        )

    sort_strategy = "speed_desc" if speed_cond and speed_cond.get("operator") == "fastest" else "timestamp_desc"

    return TrafficQueryAST(
        rawQuery=raw_query,
        intent=intent,
        vehicleClasses=classes,
        colors=colors,
        plate=plate_cond,
        speed=speed_cond,
        violations=violations,
        sort=sort_strategy,
        limit=100,
        ambiguity=ambiguity
    )
