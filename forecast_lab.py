"""Reusable ADS-506 pipeline. The browser and Quarto use the same functions."""

import csv
import io
import json
import posixpath
import re
import warnings
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

ZONES = {"California": "America/Los_Angeles", "Texas": "America/Chicago",
         "New York": "America/New_York"}
CODES = {"California": "CAL", "Texas": "TEX", "New York": "NY"}
MODELS = ("Seasonal naïve", "ETS", "ARIMA", "TSLM")
METRICS = ["MAE", "RMSE", "MASE", "ME"]
WEEK = 7
DAY = timedelta(days=1)
DEFAULTS = dict(TRAIN_END="2025-09-30", TEST_START="2025-10-01",
                TEST_END="2026-09-30", HORIZONS=[1, 7, 14], REGIONS=list(ZONES),
                CV_INITIAL=1095, CV_STEP=30, HOLDOUT_STEP=7, HOLDOUT_LAST="",
                MAX_MISSING=1, CA_ANOMALY=False)


def validate(settings):
    cfg = DEFAULTS | settings
    train, start, end = (date.fromisoformat(cfg[key]) for key in
                         ("TRAIN_END", "TEST_START", "TEST_END"))
    if not train < start <= end:
        raise ValueError("Use TRAIN_END < TEST_START ≤ TEST_END.")
    horizons = sorted(set(cfg["HORIZONS"]))
    if not horizons or any(type(h) is not int or not 1 <= h <= 60 for h in horizons):
        raise ValueError("Enter whole-number horizons from 1 to 60.")
    if not cfg["REGIONS"] or any(r not in ZONES for r in cfg["REGIONS"]):
        raise ValueError("Choose at least one supported region.")
    for key, minimum, maximum in [("CV_INITIAL", 56, 20000), ("CV_STEP", 1, 365),
                                  ("HOLDOUT_STEP", 1, 365), ("MAX_MISSING", 0, 6)]:
        if type(cfg[key]) is not int or not minimum <= cfg[key] <= maximum:
            raise ValueError(f"{key} must be a whole number from {minimum} to {maximum}.")
    if cfg["HOLDOUT_LAST"]:
        if not train <= date.fromisoformat(cfg["HOLDOUT_LAST"]) < end:
            raise ValueError("The last holdout origin must fall from TRAIN_END through TEST_END minus one day. Clear it to use the full window.")
    return cfg | {"HORIZONS": horizons, "REGIONS": list(dict.fromkeys(cfg["REGIONS"]))}


def _xlsx_rows(data):
    """Read the EIA hourly worksheet and its cached values without Excel."""
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rel = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    with zipfile.ZipFile(io.BytesIO(data)) as book:
        wb = ET.fromstring(book.read("xl/workbook.xml"))
        sheet = next((s for s in wb.iter(ns + "sheet")
                      if s.get("name", "").strip().lower() == "published hourly data"), None)
        if sheet is None:
            raise ValueError('The workbook needs a "Published Hourly Data" worksheet.')
        relationships = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
        target = next(r.get("Target") for r in relationships if r.get("Id") == sheet.get(rel + "id"))
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath("xl/" + target)
        strings = []
        if "xl/sharedStrings.xml" in book.namelist():
            root = ET.fromstring(book.read("xl/sharedStrings.xml"))
            strings = ["".join(t.text or "" for t in item.iter(ns + "t")) for item in root]
        props = wb.find(ns + "workbookPr")
        epoch = datetime(1904, 1, 1) if props is not None and props.get("date1904") in ("1", "true") else datetime(1899, 12, 30)
        with book.open(path) as xml:
            sheet_data = None
            for event, row in ET.iterparse(xml, events=("start", "end")):
                if event == "start" and row.tag == ns + "sheetData":
                    sheet_data = row
                if event != "end" or row.tag != ns + "row":
                    continue
                values = {}
                for cell in row:
                    value = cell.findtext(ns + "v")
                    kind = cell.get("t")
                    if kind == "s" and value is not None:
                        value = strings[int(value)]
                    elif kind == "inlineStr":
                        value = "".join(t.text or "" for t in cell.iter(ns + "t"))
                    elif kind in ("n", None) and value is not None:
                        value = float(value)
                    values[re.sub(r"\d", "", cell.get("r", ""))] = value
                yield epoch, values
                if sheet_data is not None:
                    sheet_data.remove(row)


def _delimited_rows(data):
    text = data.decode("utf-8-sig") if isinstance(data, bytes) else data
    header = next((line for line in text.splitlines() if line.strip()), "")
    separator = "\t" if "\t" in header else ","
    for row in csv.reader(io.StringIO(text), delimiter=separator):
        yield None, dict(enumerate(row))


def _stamp(value, epoch=None):
    if isinstance(value, (int, float)) and epoch:
        return epoch + timedelta(seconds=round(value * 86400))
    text = str(value).strip()
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        for fmt in ("%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %I:%M %p", "%m/%d/%Y"):
            try:
                return datetime.strptime(text, fmt)
            except ValueError:
                continue
    raise ValueError("Invalid date or time")


def _as_utc(stamp):
    return stamp.astimezone(timezone.utc) if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)


def read_hourly(data, region, workbook=False, ending=False):
    """Normalize into (local date, hour key, demand); keep actual demand unaggregated."""
    zone = ZoneInfo(ZONES[region])
    rows = _xlsx_rows(data) if workbook else _delimited_rows(data)
    normalize = lambda value: re.sub(r"[^a-z0-9]", "", str(value).lower())
    demand_names = ("demand", "demandmw", "mw", "demandmwh", "value")
    utc_names = ("utctime", "utctimestamp", "utc", "utctimeatendofhour", "period")
    date_names = ("localdate", "date")
    time_names = ("timestamp", "datetime", "localtime", "localtimestamp")
    for _, row in rows:
        columns = {normalize(v): k for k, v in row.items()}
        if columns.keys() & set(demand_names) and columns.keys() & set(utc_names + date_names + time_names):
            break
    else:
        raise ValueError("Expected Demand plus Local date/Hour, UTC time, or timestamp columns.")
    column = lambda names: next((columns[name] for name in names if name in columns), None)
    demand_col, utc_col, date_col, time_col, hour_col, region_col = map(
        column, (demand_names, utc_names, date_names, time_names, ("hour", "hourending"), ("region",)))
    raw, bad_time, other_region = [], 0, 0
    labels = {normalize(region), normalize(CODES[region]), "reg" + normalize(CODES[region])}
    for epoch, row in rows:
        if not any(v is not None and v != "" for v in row.values()):
            continue
        label = normalize(row.get(region_col) or "")
        if label and label not in labels:
            other_region += 1
            continue
        try:
            utc = _as_utc(_stamp(row[utc_col], epoch)) if row.get(utc_col) not in (None, "") else None
            offset = timedelta(seconds=1) if ending else timedelta()
            if row.get(date_col) not in (None, ""):
                local_day = _stamp(row[date_col], epoch).date()
                hour = row.get(hour_col)
                if utc is None and hour in (None, "") and not row.get(time_col):
                    raise ValueError("No hourly key")
                if utc is None and hour in (None, ""):
                    hour = row[time_col]
                key = utc.isoformat() if utc is not None else str(hour).strip()
            else:
                stamp = utc or _stamp(row[time_col], epoch)
                if stamp.tzinfo:
                    local = (stamp - offset).astimezone(zone)
                    key = _as_utc(stamp).isoformat()
                else:
                    local = stamp - offset
                    key = stamp.isoformat()
                local_day = local.date()
        except (ValueError, TypeError, OverflowError, KeyError):
            bad_time += 1
            continue
        try:
            value = float(str(row.get(demand_col)).replace(",", ""))
        except (ValueError, TypeError):
            value = np.nan
        raw.append((local_day, key, value))
    if not raw:
        raise ValueError(f"No hourly records found for {region}. Check the selected region and date/time columns.")
    return raw, {"invalid_times": bad_time, "other_region_rows": other_region}


def _expected_hours(day, zone):
    start = datetime.combine(day, datetime.min.time(), zone)
    end = datetime.combine(day + DAY, datetime.min.time(), zone)
    return round((_as_utc(end) - _as_utc(start)).total_seconds() / 3600)


def daily_average(raw, region, cfg, first, last):
    """Clean only the requested date interval. Keep rejected targets as NaN."""
    if first > last:
        return pd.Series(dtype=float, name="MW"), []
    groups = defaultdict(list)
    for day, key, value in raw:
        if first <= day <= last:
            groups[day].append((key, value))
    zone = ZoneInfo(ZONES[region])
    index = pd.date_range(first, last, freq="D")
    values, audit = [], []
    for stamp in index:
        day = stamp.date()
        expected = _expected_hours(day, zone)
        valid, invalid, duplicates, known, conflicts = [], 0, 0, 0, 0
        by_key = defaultdict(list)
        for key, value in groups[day]:
            by_key[key].append(value)
        # Local-only EIA rows can repeat one clock hour on a 25-hour date.
        repeated = (expected == 25 and len(by_key) == 24 and
                    len(groups[day]) == 25 and sum(len(v) == 2 for v in by_key.values()) == 1)
        for key, readings in by_key.items():
            if len(readings) > 1 and not (repeated and "T" not in key and len(key) <= 8):
                duplicates += len(readings) - 1
                usable = {v for v in readings if np.isfinite(v) and v > 0}
                if len(usable) > 1:
                    conflicts += 1
                readings = [next(iter(usable)) if len(usable) == 1 else np.nan]
            for value in readings:
                if not np.isfinite(value) or value <= 0:
                    invalid += 1
                elif (cfg["CA_ANOMALY"] and region == "California" and
                      day == date(2024, 11, 2) and value < 5000):
                    known += 1
                else:
                    valid.append(value)
        n = len(valid)
        keep = expected - cfg["MAX_MISSING"] <= n and n + invalid + known <= expected
        values.append(float(np.mean(valid)) if keep else np.nan)
        low = high = 0
        if n >= 12:
            middle = median(valid)
            low = sum(v < .35 * middle for v in valid)
            high = sum(v > 2.5 * middle for v in valid)
        if expected != 24 or n != expected or duplicates or known or low or high or not keep:
            audit.append(dict(date=day.isoformat(), expected=expected, valid=n,
                              missing=max(0, expected - n), invalid=invalid, duplicates=duplicates,
                              conflicts=conflicts, reviewed=known, unusual=low + high,
                              status="Kept" if keep else "Excluded"))
    return pd.Series(values, index=index, name="MW", dtype=float), audit


def causal_fill(series):
    """Fill model inputs from a week earlier or the last available observation."""
    result = series.loc[series.first_valid_index():].copy() if series.notna().any() else series.iloc[:0].copy()
    values = result.to_numpy(copy=True)
    for i, value in enumerate(values):
        if np.isnan(value):
            values[i] = values[i - WEEK] if i >= WEEK else values[i - 1]
    return pd.Series(values, index=result.index, name=series.name)


def build_training(sources, cfg):
    cutoff = date.fromisoformat(cfg["TRAIN_END"])
    train, checks = {}, {}
    for region in cfg["REGIONS"]:
        raw = sources[region]
        first = min(day for day, _, _ in raw)
        series, audit = daily_average(raw, region, cfg, first, cutoff)
        if not series.notna().any():
            raise ValueError(f"No usable training days for {region}. Check TRAIN_END and hourly coverage.")
        train[region], checks[region] = series, audit
    return train, checks


def diagnostics(series):
    """Training-only robust weekly STL, ACF/PACF, ADF and KPSS."""
    from statsmodels.tsa.seasonal import STL
    from statsmodels.tsa.stattools import acf, adfuller, kpss, pacf

    y = causal_fill(series)
    if len(y) < 28 or y.nunique() < 2:
        return {}
    fit = STL(y, period=WEEK, robust=True).fit()
    result = {key: np.asarray(getattr(fit, key)).tolist() for key in ("trend", "seasonal", "resid")}
    result["dates"] = y.index.strftime("%Y-%m-%d").tolist()
    result["strength"] = max(0, 1 - np.var(fit.resid) / max(1e-12, np.var(fit.seasonal + fit.resid)))
    result["stationarity"] = {}
    for name, sample in [("Level", y), ("First difference", y.diff().dropna()),
                         ("Weekly difference", y.diff(WEEK).dropna())]:
        if sample.nunique() < 2:
            continue
        lags = min(42, len(sample) // 2 - 1)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            try:
                adf, kp = adfuller(sample, autolag="AIC"), kpss(sample, regression="c", nlags="auto")
                tests = dict(adf=float(adf[0]), adf_p=float(adf[1]), kpss=float(kp[0]), kpss_p=float(kp[1]))
            except (ValueError, np.linalg.LinAlgError):
                tests = {}
        result["stationarity"][name] = dict(
            acf=acf(sample, nlags=lags).tolist(), pacf=pacf(sample, nlags=lags, method="ywm").tolist(),
            n=len(sample), **tests)
    return result


def calendar_matrix(index, start):
    t = np.asarray((index - start).days, dtype=float)
    weekday = np.asarray(index.dayofweek)
    year = 2 * np.pi * t / 365.25
    return np.column_stack([np.ones(len(index)), t / 365.25,
                            *[(weekday == day) for day in range(1, 7)],
                            np.sin(year), np.cos(year), np.sin(2 * year), np.cos(2 * year)])


def forecast_all(history, days):
    """Re-estimate four prespecified model structures at one origin."""
    from statsmodels.tsa.arima.model import ARIMA
    from statsmodels.tsa.holtwinters import ExponentialSmoothing

    y = history.to_numpy()
    next_dates = pd.date_range(history.index[-1] + DAY, periods=days)
    scale = max(abs(float(np.mean(y))), 1)
    normalized = y / scale
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ets_fit = ExponentialSmoothing(normalized, trend="add", damped_trend=True,
                                      seasonal="add", seasonal_periods=WEEK).fit()
        arima_fit = ARIMA(normalized, order=(1, 1, 1)).fit(method_kwargs={"maxiter": 50})
    train_x = calendar_matrix(history.index, history.index[0])
    future_x = calendar_matrix(next_dates, history.index[0])
    coefficients = np.linalg.lstsq(train_x, y, rcond=None)[0]
    forecasts = dict(zip(MODELS, [np.resize(y[-WEEK:], days),
                                 ets_fit.forecast(days) * scale,
                                 arima_fit.forecast(days) * scale, future_x @ coefficients]))
    if any(not np.isfinite(pred).all() for pred in forecasts.values()):
        raise ValueError("One or more models returned non-finite forecasts.")
    notices = []
    for model, fit in [("ETS", ets_fit), ("ARIMA", arima_fit)]:
        status = fit.mle_retvals
        if status is not None and not status.get("success", status.get("converged", True)):
            notices.append(model)
    return forecasts, notices


def evaluate(series, cfg, region, stage, progress=lambda message: None):
    """Expanding origins; paired targets; origin-specific weekly MASE scale."""
    raw = series
    history = causal_fill(raw)
    if len(history) < 56:
        raise ValueError(f"{region} needs at least 56 calendar days of usable history.")
    max_h = max(cfg["HORIZONS"])
    if stage == "cv":
        start, end = raw.index[0], pd.Timestamp(cfg["TRAIN_END"])
        first = history.index[0] + timedelta(days=cfg["CV_INITIAL"] - 1)
        last, step = end - timedelta(days=max_h), cfg["CV_STEP"]
    else:
        start, end = pd.Timestamp(cfg["TEST_START"]), pd.Timestamp(cfg["TEST_END"])
        first = pd.Timestamp(cfg["TRAIN_END"])
        last, step = end - timedelta(days=max_h), cfg["HOLDOUT_STEP"]
        if cfg["HOLDOUT_LAST"]:
            last = min(last, pd.Timestamp(cfg["HOLDOUT_LAST"]))
    origins = pd.date_range(first, last, freq=f"{step}D")
    observed = raw.dropna()
    if stage == "holdout":
        if first not in history.index or len(history.loc[:first]) < 56:
            raise ValueError(f"{region} needs at least 56 training calendar days before holdout.")
        # Avoid fitting origins past the last available holdout target.
        final_observed = observed.index.max()
        origins = origins[origins < final_observed]
    if not len(origins):
        raise ValueError(f"No {stage} origins for {region}. Review coverage, split dates, and window settings.")
    rows, skipped, notice_counts = [], 0, defaultdict(int)
    for i, origin in enumerate(origins, 1):
        targets = raw.reindex(pd.date_range(origin + DAY, periods=max_h))
        targets = targets.loc[start:end].dropna()
        if not len(targets):
            skipped += 1
            continue
        fit = history.loc[:origin]
        progress(f"{region} · {stage.upper()} origin {i}/{len(origins)}")
        try:
            forecasts, notices = forecast_all(fit, max_h)
        except (ValueError, RuntimeError, np.linalg.LinAlgError, FloatingPointError) as error:
            skipped += 1
            notice_counts[type(error).__name__] += 1
            continue
        for notice in notices:
            notice_counts[f"{notice} optimizer warning"] += 1
        observed_history = raw.loc[fit.index[0]:origin]
        denominator = float(observed_history.diff(WEEK).abs().mean())
        for target, actual in targets.items():
            lead = (target - origin).days
            for model, predictions in forecasts.items():
                predicted = float(predictions[lead - 1])
                error = float(actual) - predicted
                rows.append(dict(region=region, model=model, origin=origin.date().isoformat(),
                                 target=target.date().isoformat(), day=lead,
                                 actual=float(actual), forecast=predicted, error=error,
                                 absolute=abs(error), squared=error**2,
                                 scaled=abs(error) / denominator if denominator > 0 else None))
    if not rows:
        raise ValueError(f"No paired {stage} forecasts for {region}. Check target coverage and model inputs.")
    return rows, {"origins": len(origins), "skipped": skipped, "notices": dict(notice_counts)}


def score(rows, keys):
    frame = pd.DataFrame(rows)
    if frame.empty:
        return pd.DataFrame(columns=[*keys, "N", *METRICS])
    metrics = frame.groupby(keys, sort=False).agg(
        N=("error", "size"), MAE=("absolute", "mean"), RMSE=("squared", "mean"),
        MASE=("scaled", "mean"), ME=("error", "mean")).reset_index()
    metrics["RMSE"] = np.sqrt(metrics["RMSE"])
    return metrics


def run_cv(training, cfg, progress=lambda message: None):
    records, info = [], {}
    for region, series in training.items():
        rows, info[region] = evaluate(series, cfg, region, "cv", progress)
        records.extend(rows)
    requested = [row for row in records if row["day"] in cfg["HORIZONS"]]
    board = score(requested, ["region", "day", "model"])
    if len(board[["region", "day"]].drop_duplicates()) != len(cfg["REGIONS"]) * len(cfg["HORIZONS"]):
        raise ValueError("CV lacks observed targets at one or more configured horizons.")
    winners = board.sort_values("MAE", kind="stable").drop_duplicates(["region", "day"])
    return records, winners.to_dict("records"), info


def run_holdout(sources, training, cfg, progress=lambda message: None):
    """Open observed holdout data only after model specifications are frozen."""
    records, info = [], {}
    for region, series in training.items():
        cfg_end = date.fromisoformat(cfg["TEST_END"])
        first = date.fromisoformat(cfg["TRAIN_END"]) + DAY
        daily, audit = daily_average(sources[region], region, cfg, first, cfg_end)
        rows, stats = evaluate(pd.concat([series, daily]), cfg, region, "holdout", progress)
        records.extend(rows)
        start = cfg["TEST_START"]
        holdout = daily.loc[start:]
        info[region] = stats | {"observed_days": int(holdout.notna().sum()),
                                "excluded_days": int(holdout.isna().sum()),
                                "checks": [row for row in audit if row["date"] >= start]}
    return records, info


def future_forecast(sources, cfg, winners, region, horizon):
    """Refit the training-CV winner on all available history after evaluation."""
    winner = next((row for row in winners
                   if row["region"] == region and row["day"] == horizon), None)
    if winner is None:
        raise ValueError("Choose a region and horizon evaluated in training CV.")
    raw = sources[region]
    first, last = min(row[0] for row in raw), max(row[0] for row in raw)
    daily, _ = daily_average(raw, region, cfg, first, last)
    origin = daily.last_valid_index()
    if origin is None:
        raise ValueError(f"No usable daily observations for {region}.")
    observed = daily.loc[:origin]
    history = causal_fill(observed)
    predictions, notices = forecast_all(history, horizon)
    model = winner["model"]
    dates = pd.date_range(origin + DAY, periods=horizon)
    return {
        "region": region, "horizon": horizon, "model": model,
        "origin": origin.date().isoformat(), "cv_mae": winner["MAE"],
        "fit_warning": model in notices,
        "recent": list(zip(observed.index[-30:].strftime("%Y-%m-%d"), observed.iloc[-30:].tolist())),
        "predictions": [
            {"date": day.date().isoformat(), "lead": lead, "predicted_mw": float(value)}
            for lead, (day, value) in enumerate(zip(dates, predictions[model]), 1)
        ],
    }


def read_project_files(paths):
    sources = {}
    for region, name in paths.items():
        path = Path(name)
        sources[region], _ = read_hourly(path.read_bytes(), region, path.suffix.lower() == ".xlsx")
    return sources


def demo_hourly(regions):
    """Deterministic synthetic data for workflow practice, including real DST dates."""
    start, end = date(2018, 7, 1), date(2026, 10, 21)
    output = {}
    for j, region in enumerate(regions):
        zone = ZoneInfo(ZONES[region])
        rng = np.random.default_rng(506 + j)
        dates = pd.date_range(start, end - DAY)
        noises = rng.normal(0, 680 + 150 * j, len(dates))
        rows = []
        for i, stamp in enumerate(dates):
            day = stamp.date()
            hours = _expected_hours(day, zone)
            base = (29000, 43500, 17400)[j]
            amplitude = (4800, 7800, 2200)[j]
            annual = -amplitude * np.cos(2 * np.pi * (i + 120) / 365.25)
            weekly = -0.1 * base if stamp.dayofweek >= 5 else 0
            for h in range(hours):
                demand = base + annual + weekly + 0.35 * i + noises[i] + 2100 * np.sin((h - 9) * np.pi / 12)
                if region == "California" and day == date(2024, 11, 2) and h == 11:
                    demand = 4000
                if day == end - DAY:
                    demand = np.nan
                rows.append((day, str(h), float(demand)))
        output[region] = rows
    return output


def json_records(frame):
    return json.loads(frame.to_json(orient="records", date_format="iso"))
