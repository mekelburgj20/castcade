// castcade-video: adapter hygiene for ICE (D10.3.5). libwebrtc's BasicNetworkManager hands the port allocator every
// adapter with an address; on a Windows gaming rig that includes the Hyper-V / WSL vEthernet switches (172.x), APIPA
// 169.254 addresses on adapters without DHCP, IPv6 link-local (fe80::) and unique-local (fc00::/7) prefixes. None of
// those can reach the other player; each one costs a STUN round that times out ("STUN binding request timed out",
// the owner's log 2026-11-07) and useless candidates on the wire. FilteredNetworkManager is the same enumeration
// with those networks removed before the allocator sees them. Header-only: peer.cpp is its only user.
#pragma once

#include <winsock2.h>

#include <string>
#include <vector>

#include "api/environment/environment.h"
#include "rtc_base/ip_address.h"
#include "rtc_base/network.h"
#include "rtc_base/network_constants.h"
#include "rtc_base/socket_factory.h"

#include "util.h"

struct AdapterFilterResult {
  std::vector<const webrtc::Network*> kept;
  std::string summary;    // one line: what was kept and what was dropped, with the reason (names and families only)
  bool kept_all = false;  // every network would have been dropped: all of them were kept instead
};

inline std::string LowerAscii(std::string s) {
  for (auto& c : s)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return s;
}

// A host-side virtual switch or the loopback adapter. libwebrtc's release build names a Windows adapter by its
// ordinal ("0", "1", …; the friendly name only in debug builds) and keeps the driver's description ("Hyper-V Virtual
// Ethernet Adapter", "Software Loopback Interface 1", "VMware Virtual Ethernet Adapter for VMnet8"), so both are
// matched: the brief's words against the name, the host-side driver phrases against the description. "Hyper-V" alone
// is not matched in the description: a Hyper-V or Azure GUEST's own NIC is "Microsoft Hyper-V Network Adapter" and
// is the real adapter there.
inline bool AdapterLooksVirtual(const webrtc::Network& n) {
  static const char* const kVirtualName[] = {"vethernet", "wsl", "hyper-v", "vmware", "virtualbox", "loopback"};
  static const char* const kVirtualDescription[] = {"vethernet", "wsl", "hyper-v virtual ethernet", "vmware virtual", "virtualbox host-only", "loopback"};
  const std::string name = LowerAscii(n.name()), desc = LowerAscii(n.description());
  for (const char* k : kVirtualName)
    if (name.find(k) != std::string::npos) return true;
  for (const char* k : kVirtualDescription)
    if (desc.find(k) != std::string::npos) return true;
  return n.type() == webrtc::ADAPTER_TYPE_LOOPBACK;
}

// "v4 192.168.*", "v6 global", "v6 link-local", "v6 unique-local", "v6 loopback": the family and, for IPv4, the
// first two octets; never a whole address.
inline std::string AdapterAddressLabel(const webrtc::IPAddress& ip) {
  if (ip.family() == AF_INET) {
    const uint32_t v = ip.v4AddressAsHostOrderInteger();
    return "v4 " + std::to_string(v >> 24) + "." + std::to_string((v >> 16) & 255) + ".*";
  }
  if (webrtc::IPIsLoopback(ip)) return "v6 loopback";
  if (webrtc::IPIsLinkLocal(ip)) return "v6 link-local";
  if (webrtc::IPIsULA(ip)) return "v6 unique-local";
  return "v6 global";
}

// "<name> <description> (v4 192.168.*)"; the description shortened to its first 40 characters.
inline std::string AdapterLabel(const webrtc::Network& n, const webrtc::IPAddress& ip) {
  std::string d = n.description();
  if (d.size() > 40) d = d.substr(0, 40) + "…";
  return n.name() + (d.empty() ? "" : " " + d) + " (" + AdapterAddressLabel(ip) + ")";
}

// The rules: drop a network whose address is IPv4 link-local (169.254/16), IPv6 link-local (fe80::/10) or IPv6
// unique-local (fc00::/7); drop a virtual adapter (AdapterLooksVirtual) when a non-virtual adapter survives; keep global IPv6. When
// everything would go, keep everything (a rig whose only adapter is a virtual one still has to connect somewhere).
// `keep_loopback` exempts the loopback adapter from the virtual rule (the in-process self tests run on it).
inline AdapterFilterResult FilterAdapters(const std::vector<const webrtc::Network*>& all, bool keep_loopback) {
  struct Row {
    const webrtc::Network* n;
    std::string label;
    std::string reason;  // empty = kept
    bool is_virtual;
  };
  std::vector<Row> rows;
  rows.reserve(all.size());
  for (const webrtc::Network* n : all) {
    webrtc::IPAddress ip = n->GetBestIP();
    if (webrtc::IPIsUnspec(ip)) ip = n->prefix();
    Row r{n, AdapterLabel(*n, ip), "", false};
    if (webrtc::IPIsLinkLocal(ip)) r.reason = "link-local";
    else if (ip.family() == AF_INET6 && webrtc::IPIsULA(ip)) r.reason = "unique-local";
    const bool loopback = n->type() == webrtc::ADAPTER_TYPE_LOOPBACK || webrtc::IPIsLoopback(ip);
    r.is_virtual = AdapterLooksVirtual(*n) && !(keep_loopback && loopback);
    rows.push_back(std::move(r));
  }
  bool real_exists = false;
  for (const Row& r : rows)
    if (r.reason.empty() && !r.is_virtual) real_exists = true;
  for (Row& r : rows)
    if (r.reason.empty() && r.is_virtual && real_exists) r.reason = "virtual";

  AdapterFilterResult out;
  std::string kept, dropped;
  for (const Row& r : rows) {
    if (r.reason.empty()) {
      out.kept.push_back(r.n);
      kept += (kept.empty() ? "" : ", ") + r.label;
    } else {
      dropped += (dropped.empty() ? "" : ", ") + r.label + ": " + r.reason;
    }
  }
  if (out.kept.empty() && !all.empty()) {
    out.kept = all;
    out.kept_all = true;
    out.summary = "every adapter would be dropped (" + dropped + "): keeping all of them";
  } else if (all.empty()) {
    out.summary = "none enumerated";
  } else {
    out.summary = "kept " + kept + (dropped.empty() ? "" : "; dropped " + dropped);
  }
  return out;
}

// BasicNetworkManager with FilterAdapters over its list: the allocator calls GetNetworks() on the network thread at
// every gathering (each ICE generation), so the filter sees the live adapter set. One line to stderr the first time
// and whenever the verdict changes (an adapter came or went).
class FilteredNetworkManager final : public webrtc::BasicNetworkManager {
 public:
  FilteredNetworkManager(const webrtc::Environment& env, webrtc::SocketFactory* socket_factory, std::string tag, bool keep_loopback)
      : webrtc::BasicNetworkManager(env, socket_factory), tag_(std::move(tag)), keep_loopback_(keep_loopback) {}

  std::vector<const webrtc::Network*> GetNetworks() const override {
    const std::vector<const webrtc::Network*> all = webrtc::BasicNetworkManager::GetNetworks();
    AdapterFilterResult r = FilterAdapters(all, keep_loopback_);
    if (r.summary != last_summary_) {
      last_summary_ = r.summary;
      LogLine("peer %s: adapters: %s", tag_.c_str(), r.summary.c_str());
    }
    return std::move(r.kept);
  }

 private:
  const std::string tag_;
  const bool keep_loopback_;
  mutable std::string last_summary_;
};
