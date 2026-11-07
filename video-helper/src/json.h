// castcade-video: the smallest JSON the stdio protocol needs (one object per line each way). No dependency: the
// LiveKit archive does not carry libwebrtc's jsoncpp wrapper, and the protocol is a dozen flat fields.
#pragma once

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

class Json {
 public:
  enum class Type { kNull, kBool, kNumber, kString, kArray, kObject };

  Json() = default;
  static Json Null() { return Json(); }
  static Json Bool(bool b) { Json j; j.type_ = Type::kBool; j.bool_ = b; return j; }
  static Json Number(double d) { Json j; j.type_ = Type::kNumber; j.num_ = d; return j; }
  static Json Int(int64_t i) { return Number(static_cast<double>(i)); }
  static Json String(const std::string& s) { Json j; j.type_ = Type::kString; j.str_ = s; return j; }
  static Json Array() { Json j; j.type_ = Type::kArray; return j; }
  static Json Object() { Json j; j.type_ = Type::kObject; return j; }

  // Parses one document; on failure returns a null value and sets *error.
  static Json Parse(const std::string& text, std::string* error);
  // Compact one-line serialisation (integral numbers print without a fraction).
  std::string Dump() const;

  Type type() const { return type_; }
  bool is_null() const { return type_ == Type::kNull; }
  bool is_object() const { return type_ == Type::kObject; }
  bool is_array() const { return type_ == Type::kArray; }
  bool is_string() const { return type_ == Type::kString; }
  bool is_number() const { return type_ == Type::kNumber; }
  bool is_bool() const { return type_ == Type::kBool; }

  bool as_bool() const { return bool_; }
  double as_number() const { return num_; }
  const std::string& as_string() const { return str_; }
  const std::vector<Json>& items() const { return arr_; }
  const std::vector<std::pair<std::string, Json>>& members() const { return obj_; }

  // Object access (nullptr when absent); typed getters with defaults.
  const Json* Get(const char* key) const;
  bool Has(const char* key) const { return Get(key) != nullptr; }
  std::string GetString(const char* key, const std::string& def = "") const;
  double GetNumber(const char* key, double def = 0) const;
  int GetInt(const char* key, int def = 0) const { return static_cast<int>(GetNumber(key, def)); }
  bool GetBool(const char* key, bool def = false) const;

  // Builders (object: Set replaces an existing key; array: Push).
  Json& Set(const std::string& key, Json value);
  Json& Push(Json value) { arr_.push_back(std::move(value)); return *this; }

 private:
  Type type_ = Type::kNull;
  bool bool_ = false;
  double num_ = 0;
  std::string str_;
  std::vector<Json> arr_;
  std::vector<std::pair<std::string, Json>> obj_;
};
