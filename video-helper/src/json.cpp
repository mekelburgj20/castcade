#include "json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

struct Parser {
  const std::string& s;
  size_t i = 0;
  std::string err;

  void Skip() { while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++; }
  bool Fail(const char* what) { if (err.empty()) err = std::string(what) + " at offset " + std::to_string(i); return false; }

  bool ParseValue(Json* out) {
    Skip();
    if (i >= s.size()) return Fail("unexpected end");
    const char c = s[i];
    if (c == '{') return ParseObject(out);
    if (c == '[') return ParseArray(out);
    if (c == '"') { std::string str; if (!ParseString(&str)) return false; *out = Json::String(str); return true; }
    if (c == 't' && s.compare(i, 4, "true") == 0) { i += 4; *out = Json::Bool(true); return true; }
    if (c == 'f' && s.compare(i, 5, "false") == 0) { i += 5; *out = Json::Bool(false); return true; }
    if (c == 'n' && s.compare(i, 4, "null") == 0) { i += 4; *out = Json::Null(); return true; }
    if (c == '-' || (c >= '0' && c <= '9')) {
      char* end = nullptr;
      const double d = strtod(s.c_str() + i, &end);
      if (end == s.c_str() + i) return Fail("bad number");
      i = static_cast<size_t>(end - s.c_str());
      *out = Json::Number(d);
      return true;
    }
    return Fail("unexpected character");
  }

  bool ParseHex4(unsigned* v) {
    if (i + 4 > s.size()) return Fail("bad \\u escape");
    unsigned r = 0;
    for (int k = 0; k < 4; k++) {
      const char c = s[i++];
      r <<= 4;
      if (c >= '0' && c <= '9') r |= static_cast<unsigned>(c - '0');
      else if (c >= 'a' && c <= 'f') r |= static_cast<unsigned>(c - 'a' + 10);
      else if (c >= 'A' && c <= 'F') r |= static_cast<unsigned>(c - 'A' + 10);
      else return Fail("bad \\u escape");
    }
    *v = r;
    return true;
  }

  static void PutUtf8(std::string* out, unsigned cp) {
    if (cp < 0x80) out->push_back(static_cast<char>(cp));
    else if (cp < 0x800) { out->push_back(static_cast<char>(0xC0 | (cp >> 6))); out->push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
    else if (cp < 0x10000) { out->push_back(static_cast<char>(0xE0 | (cp >> 12))); out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); out->push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
    else { out->push_back(static_cast<char>(0xF0 | (cp >> 18))); out->push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F))); out->push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F))); out->push_back(static_cast<char>(0x80 | (cp & 0x3F))); }
  }

  bool ParseString(std::string* out) {
    if (s[i] != '"') return Fail("expected string");
    i++;
    while (i < s.size()) {
      const char c = s[i++];
      if (c == '"') return true;
      if (c != '\\') { out->push_back(c); continue; }
      if (i >= s.size()) break;
      const char e = s[i++];
      switch (e) {
        case '"': out->push_back('"'); break;
        case '\\': out->push_back('\\'); break;
        case '/': out->push_back('/'); break;
        case 'b': out->push_back('\b'); break;
        case 'f': out->push_back('\f'); break;
        case 'n': out->push_back('\n'); break;
        case 'r': out->push_back('\r'); break;
        case 't': out->push_back('\t'); break;
        case 'u': {
          unsigned cp;
          if (!ParseHex4(&cp)) return false;
          if (cp >= 0xD800 && cp <= 0xDBFF && i + 6 <= s.size() && s[i] == '\\' && s[i + 1] == 'u') {
            i += 2;
            unsigned lo;
            if (!ParseHex4(&lo)) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          PutUtf8(out, cp);
          break;
        }
        default: return Fail("bad escape");
      }
    }
    return Fail("unterminated string");
  }

  bool ParseArray(Json* out) {
    *out = Json::Array();
    i++;
    Skip();
    if (i < s.size() && s[i] == ']') { i++; return true; }
    for (;;) {
      Json v;
      if (!ParseValue(&v)) return false;
      out->Push(std::move(v));
      Skip();
      if (i >= s.size()) return Fail("unterminated array");
      if (s[i] == ',') { i++; continue; }
      if (s[i] == ']') { i++; return true; }
      return Fail("expected , or ]");
    }
  }

  bool ParseObject(Json* out) {
    *out = Json::Object();
    i++;
    Skip();
    if (i < s.size() && s[i] == '}') { i++; return true; }
    for (;;) {
      Skip();
      std::string key;
      if (i >= s.size() || !ParseString(&key)) return Fail("expected key");
      Skip();
      if (i >= s.size() || s[i] != ':') return Fail("expected :");
      i++;
      Json v;
      if (!ParseValue(&v)) return false;
      out->Set(key, std::move(v));
      Skip();
      if (i >= s.size()) return Fail("unterminated object");
      if (s[i] == ',') { i++; continue; }
      if (s[i] == '}') { i++; return true; }
      return Fail("expected , or }");
    }
  }
};

void DumpString(const std::string& s, std::string* out) {
  out->push_back('"');
  for (unsigned char c : s) {
    switch (c) {
      case '"': *out += "\\\""; break;
      case '\\': *out += "\\\\"; break;
      case '\n': *out += "\\n"; break;
      case '\r': *out += "\\r"; break;
      case '\t': *out += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); *out += b; }
        else out->push_back(static_cast<char>(c));
    }
  }
  out->push_back('"');
}

void DumpInto(const Json& j, std::string* out) {
  switch (j.type()) {
    case Json::Type::kNull: *out += "null"; break;
    case Json::Type::kBool: *out += j.as_bool() ? "true" : "false"; break;
    case Json::Type::kNumber: {
      const double d = j.as_number();
      char b[64];
      if (std::isfinite(d) && d == std::floor(d) && std::fabs(d) < 9e15) snprintf(b, sizeof b, "%lld", static_cast<long long>(d));
      else if (std::isfinite(d)) snprintf(b, sizeof b, "%.6g", d);
      else snprintf(b, sizeof b, "null");
      *out += b;
      break;
    }
    case Json::Type::kString: DumpString(j.as_string(), out); break;
    case Json::Type::kArray: {
      out->push_back('[');
      bool first = true;
      for (const auto& v : j.items()) { if (!first) out->push_back(','); first = false; DumpInto(v, out); }
      out->push_back(']');
      break;
    }
    case Json::Type::kObject: {
      out->push_back('{');
      bool first = true;
      for (const auto& kv : j.members()) {
        if (!first) out->push_back(',');
        first = false;
        DumpString(kv.first, out);
        out->push_back(':');
        DumpInto(kv.second, out);
      }
      out->push_back('}');
      break;
    }
  }
}

}  // namespace

Json Json::Parse(const std::string& text, std::string* error) {
  Parser p{text};
  Json out;
  if (!p.ParseValue(&out)) {
    if (error) *error = p.err;
    return Json();
  }
  p.Skip();
  if (p.i != text.size()) {
    if (error) *error = "trailing characters";
    return Json();
  }
  return out;
}

std::string Json::Dump() const {
  std::string out;
  DumpInto(*this, &out);
  return out;
}

const Json* Json::Get(const char* key) const {
  if (type_ != Type::kObject) return nullptr;
  for (const auto& kv : obj_) if (kv.first == key) return &kv.second;
  return nullptr;
}

std::string Json::GetString(const char* key, const std::string& def) const {
  const Json* v = Get(key);
  return v && v->is_string() ? v->str_ : def;
}

double Json::GetNumber(const char* key, double def) const {
  const Json* v = Get(key);
  return v && v->is_number() ? v->num_ : def;
}

bool Json::GetBool(const char* key, bool def) const {
  const Json* v = Get(key);
  return v && v->is_bool() ? v->bool_ : def;
}

Json& Json::Set(const std::string& key, Json value) {
  if (type_ != Type::kObject) { *this = Object(); }
  for (auto& kv : obj_) if (kv.first == key) { kv.second = std::move(value); return *this; }
  obj_.emplace_back(key, std::move(value));
  return *this;
}
