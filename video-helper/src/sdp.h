// castcade-video: the one SDP edit the helper makes. The send codec's parameters come from the REMOTE description, so
// libwebrtc's x-google-start/min/max-bitrate ride in the remote offer's or answer's a=fmtp line of every H264 payload
// before SetRemoteDescription (the spike's finding). Nothing else in the SDP is touched; ICE candidates trickle.
#pragma once

#include <map>
#include <string>

std::string AddFmtpExtras(const std::string& sdp, const std::string& codec_name, const std::map<std::string, std::string>& extras);
