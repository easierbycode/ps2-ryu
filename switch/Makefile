# Nintendo Switch homebrew build (devkitPro devkitA64 + libnx + SDL2
# portlibs, quickjs-ng vendored as a submodule). devkitPro's canonical
# application Makefile shape, trimmed to this project: no C++, no DATA,
# quickjs-ng core compiled straight out of vendor/quickjs via VPATH.
#
# Build via `npm run nro` at the repo root (stages romfs first, uses Docker
# when no local devkitPro exists), or `make` here inside a devkitA64 env.
.SUFFIXES:

ifeq ($(strip $(DEVKITPRO)),)
$(error "Please set DEVKITPRO in your environment. export DEVKITPRO=<path to>/devkitpro")
endif

TOPDIR ?= $(CURDIR)
include $(DEVKITPRO)/libnx/switch_rules

APP_TITLE   := Ryu PS2
APP_AUTHOR  := EasierByCode
APP_VERSION := 0.1.0

TARGET   := ps2-ryu
BUILD    := build
SOURCES  := source
INCLUDES := source vendor/quickjs
ROMFS    := romfs

# quickjs-ng core only — no quickjs-libc.c; source/js_module.c is the module
# loader and source/host_std.c provides the small `std` subset the game reads
# its Tiled maps through
QJS_SOURCES := quickjs.c libregexp.c libunicode.c dtoa.c

ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE

CFLAGS := -g -Wall -O2 -ffunction-sections $(ARCH) $(DEFINES)
CFLAGS += $(INCLUDE) -D__SWITCH__ -D_GNU_SOURCE
CXXFLAGS := $(CFLAGS) -fno-rtti -fno-exceptions
ASFLAGS := -g $(ARCH)
LDFLAGS = -specs=$(DEVKITPRO)/libnx/switch.specs -g $(ARCH) -Wl,-Map,$(notdir $*.map)

PKGCONF := $(DEVKITPRO)/portlibs/switch/bin/aarch64-none-elf-pkg-config
LIBS := $(shell $(PKGCONF) --libs --static sdl2 SDL2_image SDL2_ttf) -lm -lnx

LIBDIRS := $(PORTLIBS) $(LIBNX)

ifneq ($(BUILD),$(notdir $(CURDIR)))

export OUTPUT := $(CURDIR)/$(TARGET)
export TOPDIR := $(CURDIR)
export VPATH := $(foreach dir,$(SOURCES),$(CURDIR)/$(dir)) $(CURDIR)/vendor/quickjs
export DEPSDIR := $(CURDIR)/$(BUILD)

CFILES := $(foreach dir,$(SOURCES),$(notdir $(wildcard $(dir)/*.c))) $(QJS_SOURCES)

export LD := $(CC)
export OFILES := $(CFILES:.c=.o)
export INCLUDE := $(foreach dir,$(INCLUDES),-I$(CURDIR)/$(dir)) \
	$(foreach dir,$(LIBDIRS),-I$(dir)/include) \
	-I$(CURDIR)/$(BUILD)
export LIBPATHS := $(foreach dir,$(LIBDIRS),-L$(dir)/lib)

ifeq ($(strip $(ICON)),)
	icons := $(wildcard *.jpg)
	ifneq (,$(findstring $(TARGET).jpg,$(icons)))
		export APP_ICON := $(TOPDIR)/$(TARGET).jpg
	else
		ifneq (,$(findstring icon.jpg,$(icons)))
			export APP_ICON := $(TOPDIR)/icon.jpg
		endif
	endif
else
	export APP_ICON := $(TOPDIR)/$(ICON)
endif

ifneq ($(strip $(APP_ICON)),)
	export NROFLAGS += --icon=$(APP_ICON)
endif

export NROFLAGS += --nacp=$(CURDIR)/$(TARGET).nacp

ifneq ($(ROMFS),)
	export NROFLAGS += --romfsdir=$(CURDIR)/$(ROMFS)
endif

.PHONY: $(BUILD) clean all

all: $(BUILD)

$(BUILD):
	@[ -d $@ ] || mkdir -p $@
	@$(MAKE) --no-print-directory -C $(BUILD) -f $(CURDIR)/Makefile

clean:
	@echo clean ...
	@rm -fr $(BUILD) $(TARGET).nro $(TARGET).nacp $(TARGET).elf

else

DEPENDS := $(OFILES:.o=.d)

.PHONY: all

all: $(OUTPUT).nro

# relink when staged romfs content changes (JS-only edits still rebuild
# the NRO without touching any C)
ROMFS_FILES := $(shell find $(TOPDIR)/$(ROMFS) -type f 2>/dev/null)

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp $(ROMFS_FILES)

$(OUTPUT).elf: $(OFILES)

-include $(DEPENDS)

endif
