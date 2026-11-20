; E10: the NSIS include of the Witness edition's installer (electron-builder.witness.yml `nsis.include`). It is
; installer.nsh with CASTCADE_WITNESS_EDITION defined: the update logic of E9 exactly as in the full installer, no
; firewall rule and no castcade:// keys, and both removed when a full install left them (see installer.nsh).
!define CASTCADE_WITNESS_EDITION
!include "${__FILEDIR__}\installer.nsh"
