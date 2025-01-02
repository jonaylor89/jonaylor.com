function classesFromArray(index, array, split, github) {
    let length = array.length;
    let output = "";
    if (!split) {
        output += "col-xs-";
        output += 12 / length;
    } else {
        output += "col-xs-" + split[index];
    }

    if (length == 2) {
        if (index == 0) {
            output += " text-letter-spacing-1px";
        }
        if (index == 1) {
            output += " text-xs-right";
        }
    }
    if (length == 3) {
        switch (index) {
            case 0:
                output += " header-aside";
                break;
            case 1:
                output += " wide-middle"
                output += " text-xs-center text-letter-spacing-1px";
                break;
            case 2:
                output += " header-aside";
                output += " italic";
                output += " text-xs-right";
                break;
        }
    }
    if (github && index == 0) output += " octocat-sm";
    return output;
}

function widthClassFromArray(array) {
    let length = array.length;
    let output = "";
    output += "col-xs-";
    output += 12 / length;
    // console.log(12 / length);
    return output;
}

function textAlignFromArray(index, array) {
    let length = array.length;
    let output = "";
    if (length == 2) {
        if (index == 0) {
            output += " text-letter-spacing-1px";
        }
        if (index == 1) {
            output += "text-xs-right";
        }
    }
    if (length == 3) {
        if (index == 1) {
            output += "text-xs-center text-letter-spacing-1px";
        }
        if (index == 2) {
            output += "text-xs-right";
        }
    }
    return output;
}

function createList(array, sort = false) {
    array = array.filter((data) => data != "")
    if (array.length == 0)
        return;
    if (sort) array.sort();
    let delimiter = "&emsp;&diams;&emsp;";
    delimiter = "<span class='delimiter'>" + delimiter + "</span>";
    let output = "<span>" + array[0] + "</span>";
    for (let i = 1; i < array.length; i++)
        output += delimiter + "<span>" + array[i] + "</span>";
    return output;
}

function getIcon(icon = "", color = "", size = "") {
    // console.log(icon);
    if (icon) {
        let html = '<i class="black fa fa-' + icon + '" aria-hidden="true" style="';
        html += size ? "font-size: " + size + ";" : "";
        html += color ? "color: " + color + ";" : ""; 
        html += '"></i>';
        return html;
    }
    return "";
}

function removeMarkup(s){
    if(shouldHide(s)){
        return s.substring(1);
    }
    return s;
}

function shouldHide(s){
    return s.startsWith("~");
}

ko.bindingHandlers.trimList = {
    init: function(element) {},
    update: function(list) {
        let previous;
        $(list).children().each((index, span) => {
            if (index == 0) previous = $(span);
            if ($(span).offset().top != previous.offset().top) {
                //previous was on the previous Line
                if (previous.is(".delimiter")) { //If it was a delimiter, let's hide it
                    let prevTop = previous.offset().top;
                    // console.log("| " + previous.offset().top)
                    previous.hide();
                    // console.log(previous.offset().top + " |")
                    if($(span).offset().top == prevTop){
                        $(span).before("</br>");
                    }
                } else { //If it was not a delimiter, then we hide current IF the text didn't wrap
                    $(span).hide();
                }
            }
            previous = $(span);
            // console.log($(span).offset().top);
        });
    }
}
ko.bindingHandlers.handlePageBreak = {
    init: function(element) {},
    update: function(list,value){
        if(!value()) return;
        let pageHeight = 1047;
        let pageTop = 0;
        $("main").children().each( (index,div) => {
            let divBottom = $(div).offset().top + $(div).height();
            // console.log(div);
            // console.log(divBottom);
            if(divBottom > pageTop + pageHeight){
                $(div).find("table").addClass("after-page-break");
                pageTop += pageHeight;
            }
        });
    }
}

ko.applyBindings(new viewModel());

// window.onload = function() {
//     convertToPDF(document.documentElement.outerHTML);
// }

function convertToPDF(content) {
    // Create new PDFreactor instance
    // var pdfReactor = new PDFreactor("http://yourServer:9423/service/rest");
    var pdfReactor = new PDFreactor();
    // Create a new PDFreactor configuration object

    var config = {
        // Specify the input document
        document: content,
        // Set a base URL for images, style sheets, links
        baseURL: window.location.href,
        // Set an appropriate log level
        logLevel: PDFreactor.LogLevel.WARN,
        // Set the title of the created PDF
        title: "Demonstration of the PDFreactor JavaScript API",
        // Set the author of the created PDF
        author: "Myself",
        // Enable links in the PDF document
        addLinks: true,
    }

    // Render document and save result
    pdfReactor.convert(config, function(result) {
        // console.log(result);
        downloadPdf('resune.pdf', result.document);
    }, function(error) {
        document.body.innerHTML = "<h1>An Error Has Occurred</h1>" +
            "<h2>" + error + "</h2>";
    });
}

function downloadPdf(filename, text) {
    var pom = document.createElement('a');
    pom.setAttribute('href', 'data:application/pdf;base64,' + encodeURIComponent(text));
    pom.setAttribute('download', filename);

    if (document.createEvent) {
        var event = document.createEvent('MouseEvents');
        event.initEvent('click', true, true);
        pom.dispatchEvent(event);
    } else {
        pom.click();
    }
}